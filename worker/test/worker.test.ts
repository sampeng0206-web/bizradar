import fs from 'node:fs';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { Webhook } from 'svix';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  Env,
  generateTaxIdSignature,
  verifyTaxIdSignature,
} from '../src/index';

describe('第二部分：Cloudflare Worker (bizradar-mailer) 簽章、拒收、每日上限、拒收擋寄與問卷測試', () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  const migrationSql = fs.readFileSync(
    path.resolve(__dirname, '../migrations/0001_init.sql'),
    'utf-8'
  );

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: {
        DB: 'test-bizradar-db',
      },
    });
    db = await mf.getD1Database('DB');

    const statements = migrationSql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  beforeEach(async () => {
    await db.prepare('DELETE FROM suppressions').run();
    await db.prepare('DELETE FROM survey_responses').run();
    await db.prepare('DELETE FROM send_log').run();
    await db.prepare('DELETE FROM email_events').run();

    env = {
      DB: db,
      FROM_EMAIL: '沃客買 <hello@mail.workmateiia.com>',
      REPLY_TO: 'sampeng0206@gmail.com',
      COMPANY_NAME: '沃客買創業投資股份有限公司',
      COMPANY_ADDRESS: '臺北市信義區測試路1號',
      COMPANY_PHONE: '02-1234-5678',
      COMPANY_WEBSITE: 'https://workmateiia.com',
      DAILY_LIMIT: '2', // 測試每日上限設為 2
      ALLOWED_ORIGINS: 'http://localhost:5173,https://sampeng0206-web.github.io',
      GCIS_URL:
        'https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C?$format=json&$filter=Business_Accounting_NO%20eq%20{taxId}&$skip=0&$top=50',
      RESEND_API_KEY: 're_test_key_placeholder',
      APP_TOKEN: 'test_app_token_secret',
      LINK_SECRET: 'test_link_hmac_secret',
      RESEND_WEBHOOK_SECRET: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    };
  });

  it('連結簽章：HMAC-SHA256 base64url 前16字產生與驗章正確，且 /sign 批次簽章正常運作', async () => {
    const sig = await generateTaxIdSignature(env.LINK_SECRET, '20828393');
    expect(sig).toHaveLength(16);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{16}$/);

    expect(
      await verifyTaxIdSignature(env.LINK_SECRET, '20828393', sig)
    ).toBe(true);
    expect(
      await verifyTaxIdSignature(env.LINK_SECRET, '20828393', 'wrong_signature_')
    ).toBe(false);

    const req = new Request('https://worker.example.com/sign', {
      method: 'POST',
      headers: {
        'Origin': 'http://localhost:5173',
        'Authorization': `Bearer ${env.APP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taxIds: ['20828393', '12345678'] }),
    });
    const resp = await worker.fetch(req, env);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as Record<
      string,
      { survey: string; unsubscribe: string }
    >;
    expect(data['20828393'].survey).toContain(`id=20828393&sig=${sig}`);
    expect(data['20828393'].unsubscribe).toContain(`id=20828393&sig=${sig}`);
  });

  it('GET /u 只顯示繁中確認頁且不得執行拒收；POST /u 寫入統編與寄過的 email 至 suppressions', async () => {
    const taxId = '20828393';
    const sig = await generateTaxIdSignature(env.LINK_SECRET, taxId);

    // 先模擬一筆寄送紀錄
    await db
      .prepare(
        'INSERT INTO send_log (tax_id, to_email, resend_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(
        taxId,
        'founder@company.com.tw',
        're_123',
        'sent',
        '',
        new Date().toISOString()
      )
      .run();

    // GET /u 不得寫入 suppressions
    const getReq = new Request(
      `https://worker.example.com/u?id=${taxId}&sig=${sig}`,
      { method: 'GET' }
    );
    const getResp = await worker.fetch(getReq, env);
    expect(getResp.status).toBe(200);
    const getHtml = await getResp.text();
    expect(getHtml).toContain('確定不再收到沃客買的服務資訊？');

    const supBefore = await db
      .prepare('SELECT * FROM suppressions WHERE key = ?')
      .bind(taxId)
      .first();
    expect(supBefore).toBeNull();

    // POST /u 實際執行拒收
    const postReq = new Request(
      `https://worker.example.com/u?id=${taxId}&sig=${sig}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }
    );
    const postResp = await worker.fetch(postReq, env);
    expect(postResp.status).toBe(200);
    const postHtml = await postResp.text();
    expect(postHtml).toContain('已完成拒收');

    const supTax = await db
      .prepare('SELECT * FROM suppressions WHERE key = ?')
      .bind(taxId)
      .first();
    const supEmail = await db
      .prepare('SELECT * FROM suppressions WHERE key = ?')
      .bind('founder@company.com.tw')
      .first();
    expect(supTax).not.toBeNull();
    expect(supEmail).not.toBeNull();
  });

  it('POST /send：拒收擋寄 (409) 與台灣時間每日上限 (429)', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        if (urlStr === 'https://api.resend.com/emails') {
          return new Response(JSON.stringify({ id: 're_mock_001' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }
    );

    try {
      // 1. 先將 99999999 加入 suppressions，測試 409 拒收擋寄
      await db
        .prepare(
          'INSERT INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(
          '99999999',
          'taxId',
          '手動排除',
          'manual',
          new Date().toISOString()
        )
        .run();

      const blockedReq = new Request('https://worker.example.com/send', {
        method: 'POST',
        headers: {
          'Origin': 'http://localhost:5173',
          'Authorization': `Bearer ${env.APP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taxId: '99999999',
          to: 'blocked@example.com',
          subject: '測試主旨',
          text: '問卷：{{問卷連結}} 拒收：{{拒收連結}}',
        }),
      });
      const blockedResp = await worker.fetch(blockedReq, env);
      expect(blockedResp.status).toBe(409);

      // 2. 正常寄送第 1 封與第 2 封（DAILY_LIMIT = 2）
      for (let i = 1; i <= 2; i++) {
        const okReq = new Request('https://worker.example.com/send', {
          method: 'POST',
          headers: {
            'Origin': 'http://localhost:5173',
            'Authorization': `Bearer ${env.APP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            taxId: `1000000${i}`,
            to: `user${i}@example.com`,
            subject: '恭喜新設立',
            text: '問卷：{{問卷連結}} 拒收：{{拒收連結}}',
          }),
        });
        const okResp = await worker.fetch(okReq, env);
        expect(okResp.status).toBe(200);
        const okJson = (await okResp.json()) as {
          ok: boolean;
          resendId: string;
          remainingToday: number;
        };
        expect(okJson.ok).toBe(true);
        expect(okJson.remainingToday).toBe(2 - i);
      }

      // 3. 第 3 封超過 DAILY_LIMIT (2) -> 應回傳 429
      const limitReq = new Request('https://worker.example.com/send', {
        method: 'POST',
        headers: {
          'Origin': 'http://localhost:5173',
          'Authorization': `Bearer ${env.APP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taxId: '10000003',
          to: 'user3@example.com',
          subject: '恭喜新設立',
          text: '內容',
        }),
      });
      const limitResp = await worker.fetch(limitReq, env);
      expect(limitResp.status).toBe(429);
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('問卷 /s：同意聯繫不得預設勾選、同一統編最多接受 3 次、選「不需要聯繫」自動寫入 suppressions', async () => {
    const taxId = '55667788';
    const sig = await generateTaxIdSignature(env.LINK_SECRET, taxId);

    const getResp = await worker.fetch(
      new Request(`https://worker.example.com/s?id=${taxId}&sig=${sig}`),
      env
    );
    expect(getResp.status).toBe(200);
    const html = await getResp.text();
    expect(html).not.toContain('checked');

    // 送出 3 次問卷（第 3 次選「不需要聯繫」）
    for (let i = 1; i <= 3; i++) {
      const form = new URLSearchParams();
      form.append('needs', '找錢（貸款／補助／募資）');
      form.append('timing', '近期（1個月內）');
      form.append('contactPref', i === 3 ? '不需要聯繫' : 'Email');
      form.append('company', '測試股份有限公司');
      form.append('contact', 'test@company.com');
      if (i < 3) form.append('consent', '1');

      const postResp = await worker.fetch(
        new Request(`https://worker.example.com/s?id=${taxId}&sig=${sig}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
        env
      );
      expect(postResp.status).toBe(200);
    }

    // 第 4 次應回傳 429
    const fourthResp = await worker.fetch(
      new Request(`https://worker.example.com/s?id=${taxId}&sig=${sig}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'contactPref=Email',
      }),
      env
    );
    expect(fourthResp.status).toBe(429);

    // 確認選「不需要聯繫」已寫入 suppressions
    const sup = await db
      .prepare('SELECT * FROM suppressions WHERE key = ?')
      .bind(taxId)
      .first<{ source: string }>();
    expect(sup?.source).toBe('survey');
  });

  it('POST /resend-webhook：驗證 svix 簽章並將 email.bounced 寫入 email_events 與 suppressions', async () => {
    const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
    const msgId = 'msg_test_12345';
    const now = new Date();
    const payload = JSON.stringify({
      type: 'email.bounced',
      data: {
        email_id: 're_bounce_999',
        to: ['BounceUser@Example.com'],
      },
    });
    const signature = wh.sign(msgId, now, payload);

    const req = new Request('https://worker.example.com/resend-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': msgId,
        'svix-timestamp': String(Math.floor(now.getTime() / 1000)),
        'svix-signature': signature,
      },
      body: payload,
    });

    const resp = await worker.fetch(req, env);
    expect(resp.status).toBe(200);

    const ev = await db
      .prepare('SELECT * FROM email_events WHERE resend_id = ?')
      .bind('re_bounce_999')
      .first<{ type: string; email: string }>();
    expect(ev?.type).toBe('email.bounced');
    expect(ev?.email).toBe('bounceuser@example.com');

    const sup = await db
      .prepare('SELECT * FROM suppressions WHERE key = ?')
      .bind('bounceuser@example.com')
      .first<{ reason: string; source: string }>();
    expect(sup?.reason).toBe('bounced');
    expect(sup?.source).toBe('bounce');
  });
});
