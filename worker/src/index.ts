import { Webhook } from 'svix';

export interface Env {
  DB: D1Database;
  FROM_EMAIL: string;
  REPLY_TO: string;
  COMPANY_NAME: string;
  COMPANY_ADDRESS: string;
  COMPANY_PHONE: string;
  COMPANY_WEBSITE: string;
  DAILY_LIMIT: string;
  ALLOWED_ORIGINS: string;
  GCIS_URL: string;
  RESEND_API_KEY: string;
  APP_TOKEN: string;
  LINK_SECRET: string;
  RESEND_WEBHOOK_SECRET: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * 連結簽章：sig = HMAC-SHA256(LINK_SECRET, 統編) 取 base64url 前16字
 */
export async function generateTaxIdSignature(
  secret: string,
  taxId: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(taxId));
  return toBase64Url(new Uint8Array(sigBuf)).slice(0, 16);
}

/**
 * Timing-safe 字串比對（透過固定長度 SHA-256 雜湊後逐位元組常數時間比對）
 */
export async function timingSafeEqualStrings(
  a: string,
  b: string
): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  let diff = a.length ^ b.length;
  for (let i = 0; i < viewA.length; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

export async function verifyTaxIdSignature(
  secret: string,
  taxId: string,
  sig: string
): Promise<boolean> {
  if (!secret || !taxId || !sig) return false;
  const expected = await generateTaxIdSignature(secret, taxId);
  return timingSafeEqualStrings(expected, sig);
}

/**
 * 計算台灣時間（UTC+8）今日 00:00:00 對應之 UTC ISO 字串
 */
export function getTaiwanTodayStartIso(now: Date = new Date()): string {
  const twOffsetMs = 8 * 60 * 60 * 1000;
  const twTime = new Date(now.getTime() + twOffsetMs);
  const twMidnightUtcMs =
    Date.UTC(
      twTime.getUTCFullYear(),
      twTime.getUTCMonth(),
      twTime.getUTCDate(),
      0,
      0,
      0,
      0
    ) - twOffsetMs;
  return new Date(twMidnightUtcMs).toISOString();
}

function getCorsHeaders(
  request: Request,
  env: Env
): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get('Origin') || '';
  const allowedList = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!origin) {
    // 非瀏覽器或同源無 Origin header
    return {
      allowed: true,
      headers: {
        'Vary': 'Origin',
      },
    };
  }

  if (allowedList.includes(origin)) {
    return {
      allowed: true,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    };
  }

  return { allowed: false, headers: { 'Vary': 'Origin' } };
}

function jsonResponse(
  body: unknown,
  status = 200,
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function checkBearerAuth(request: Request, env: Env): Promise<boolean> {
  if (!env.APP_TOKEN) return false;
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;
  return timingSafeEqualStrings(token, env.APP_TOKEN);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    const cors = getCorsHeaders(request, env);

    // 處理 CORS Preflight OPTIONS
    if (method === 'OPTIONS') {
      if (!cors.allowed) {
        return new Response('Forbidden Origin', { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors.headers });
    }

    // 需驗證 APP_TOKEN 與 CORS 的 API 端點：/send、/sign、/sync、/gcis
    if (
      path === '/send' ||
      path === '/sign' ||
      path === '/sync' ||
      path === '/gcis'
    ) {
      if (!cors.allowed) {
        return jsonResponse(
          { ok: false, error: 'Origin not allowed by CORS' },
          403
        );
      }
      const authorized = await checkBearerAuth(request, env);
      if (!authorized) {
        return jsonResponse(
          { ok: false, error: 'Unauthorized' },
          401,
          cors.headers
        );
      }
    }

    // 1. POST /send {taxId,to,subject,text}
    if (path === '/send' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        taxId?: string;
        to?: string;
        subject?: string;
        text?: string;
      } | null;

      const taxId = (body?.taxId || '').trim();
      const toEmail = (body?.to || '').trim().toLowerCase();
      const subject = (body?.subject || '').trim();
      const rawText = body?.text || '';

      if (!taxId || !toEmail || !subject || !rawText) {
        return jsonResponse(
          { ok: false, error: 'Missing required fields (taxId, to, subject, text)' },
          400,
          cors.headers
        );
      }

      // 檢查 to 或 taxId 是否在 suppressions → 409
      const suppressed = await env.DB.prepare(
        'SELECT key, reason FROM suppressions WHERE key = ? OR key = ? LIMIT 1'
      )
        .bind(taxId, toEmail)
        .first<{ key: string; reason: string }>();

      if (suppressed) {
        return jsonResponse(
          {
            ok: false,
            error: `Target is suppressed (${suppressed.key}: ${suppressed.reason})`,
          },
          409,
          cors.headers
        );
      }

      // 台灣時間今日 send_log 成功數 ≥ DAILY_LIMIT → 429
      const dailyLimit = Math.max(1, Number(env.DAILY_LIMIT || '20'));
      const todayStartIso = getTaiwanTodayStartIso();
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM send_log WHERE status = 'sent' AND created_at >= ?"
      )
        .bind(todayStartIso)
        .first<{ cnt: number }>();

      const sentToday = Number(countRow?.cnt || 0);
      if (sentToday >= dailyLimit) {
        return jsonResponse(
          {
            ok: false,
            error: '今日已達上限',
            remainingToday: 0,
          },
          429,
          cors.headers
        );
      }

      // 產生問卷與拒收簽章連結並替換 {{問卷連結}}、{{拒收連結}}
      const sig = await generateTaxIdSignature(env.LINK_SECRET, taxId);
      const baseUrl = `${url.protocol}//${url.host}`;
      const surveyUrl = `${baseUrl}/s?id=${encodeURIComponent(taxId)}&sig=${encodeURIComponent(sig)}`;
      const unsubUrl = `${baseUrl}/u?id=${encodeURIComponent(taxId)}&sig=${encodeURIComponent(sig)}`;

      const finalText = rawText
        .replace(/\{\{問卷連結\}\}/g, surveyUrl)
        .replace(/\{\{拒收連結\}\}/g, unsubUrl);

      const nowIso = new Date().toISOString();

      // 呼叫 Resend API
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: toEmail,
          subject,
          text: finalText,
          reply_to: env.REPLY_TO,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
      });

      if (!resendResp.ok) {
        const errText = await resendResp.text().catch(() => 'Resend error');
        await env.DB.prepare(
          'INSERT INTO send_log (tax_id, to_email, resend_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(taxId, toEmail, '', 'failed', errText, nowIso)
          .run();

        return jsonResponse(
          {
            ok: false,
            error: errText,
            remainingToday: Math.max(0, dailyLimit - sentToday),
          },
          502,
          cors.headers
        );
      }

      const resendData = (await resendResp.json().catch(() => ({}))) as {
        id?: string;
      };
      const resendId = resendData.id || '';

      await env.DB.prepare(
        'INSERT INTO send_log (tax_id, to_email, resend_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(taxId, toEmail, resendId, 'sent', '', nowIso)
        .run();

      return jsonResponse(
        {
          ok: true,
          resendId,
          remainingToday: Math.max(0, dailyLimit - (sentToday + 1)),
        },
        200,
        cors.headers
      );
    }

    // 2. POST /sign {taxIds:[]} (上限500)
    if (path === '/sign' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        taxIds?: string[];
      } | null;
      const taxIds = Array.isArray(body?.taxIds) ? body!.taxIds : [];
      if (taxIds.length > 500) {
        return jsonResponse(
          { ok: false, error: 'Batch limit exceeded (max 500 taxIds)' },
          400,
          cors.headers
        );
      }

      const baseUrl = `${url.protocol}//${url.host}`;
      const result: Record<string, { survey: string; unsubscribe: string }> =
        {};

      for (const rawId of taxIds) {
        const id = String(rawId || '').trim();
        if (!id) continue;
        const sig = await generateTaxIdSignature(env.LINK_SECRET, id);
        result[id] = {
          survey: `${baseUrl}/s?id=${encodeURIComponent(id)}&sig=${encodeURIComponent(sig)}`,
          unsubscribe: `${baseUrl}/u?id=${encodeURIComponent(id)}&sig=${encodeURIComponent(sig)}`,
        };
      }

      return jsonResponse(result, 200, cors.headers);
    }

    // 3. GET /u -> 繁中確認頁「確定不再收到沃客買的服務資訊？」按鈕送 POST /u (GET 本身不得執行拒收)
    if (path === '/u' && method === 'GET') {
      const taxId = (url.searchParams.get('id') || '').trim();
      const sig = (url.searchParams.get('sig') || '').trim();
      const valid = await verifyTaxIdSignature(env.LINK_SECRET, taxId, sig);
      if (!valid) {
        return htmlResponse(
          `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>連結無效</title></head><body style="font-family:sans-serif;padding:24px;text-align:center;"><h2>拒收連結簽章無效或已過期</h2></body></html>`,
          400
        );
      }

      const actionUrl = `/u?id=${encodeURIComponent(taxId)}&sig=${encodeURIComponent(sig)}`;
      return htmlResponse(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>拒收確認｜沃客買</title>
  <style>
    body { font-family: 'Microsoft JhengHei', sans-serif; background: #f4f6f9; color: #1e293b; display: flex; justify-content: center; align-items: center; min-height: 90vh; margin: 0; padding: 16px; }
    .box { background: #fff; border: 1px solid #dce1e7; border-radius: 10px; max-width: 440px; width: 100%; padding: 28px 24px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    h1 { font-size: 20px; color: #1e3a5f; margin-top: 0; }
    p { font-size: 14px; color: #475569; line-height: 1.6; }
    button { background: #b91c1c; color: #fff; border: none; border-radius: 6px; padding: 12px 24px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 12px; width: 100%; }
  </style>
</head>
<body>
  <div class="box">
    <h1>確定不再收到沃客買的服務資訊？</h1>
    <p>統一編號：${escapeHtml(taxId)}<br>點擊下方按鈕確認後，我們將立即把貴公司列入拒收名單，不再寄送後續相關資訊。</p>
    <form method="POST" action="${actionUrl}">
      <input type="hidden" name="id" value="${escapeHtml(taxId)}">
      <input type="hidden" name="sig" value="${escapeHtml(sig)}">
      <button type="submit">確認拒收</button>
    </form>
  </div>
</body>
</html>`);
    }

    // 4. POST /u -> 驗簽章，寫入 suppressions(統編)，並把 send_log 中該統編寄過的 email 一併寫入；顯示「已完成拒收」
    if (path === '/u' && method === 'POST') {
      let taxId = (url.searchParams.get('id') || '').trim();
      let sig = (url.searchParams.get('sig') || '').trim();

      if (!taxId || !sig) {
        const formData = await request.formData().catch(() => null);
        if (formData) {
          taxId = taxId || String(formData.get('id') || '').trim();
          sig = sig || String(formData.get('sig') || '').trim();
        }
      }

      const valid = await verifyTaxIdSignature(env.LINK_SECRET, taxId, sig);
      if (!valid) {
        return htmlResponse(
          `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>連結無效</title></head><body><h2>拒收連結簽章無效</h2></body></html>`,
          400
        );
      }

      const nowIso = new Date().toISOString();
      await env.DB.prepare(
        'INSERT OR REPLACE INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(taxId, 'taxId', '客戶點擊拒收連結', 'unsubscribe', nowIso)
        .run();

      // 把 send_log 中該統編寄過的 email 一併寫入 suppressions
      const sentEmails = await env.DB.prepare(
        'SELECT DISTINCT to_email FROM send_log WHERE tax_id = ?'
      )
        .bind(taxId)
        .all<{ to_email: string }>();

      for (const row of sentEmails.results || []) {
        const em = (row.to_email || '').trim().toLowerCase();
        if (em) {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(em, 'email', '客戶點擊拒收連結（連帶信箱）', 'unsubscribe', nowIso)
            .run();
        }
      }

      return htmlResponse(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>已完成拒收｜沃客買</title>
  <style>
    body { font-family: 'Microsoft JhengHei', sans-serif; background: #f4f6f9; color: #1e293b; display: flex; justify-content: center; align-items: center; min-height: 90vh; margin: 0; padding: 16px; }
    .box { background: #fff; border: 1px solid #dce1e7; border-radius: 10px; max-width: 440px; width: 100%; padding: 28px 24px; text-align: center; }
    h1 { font-size: 20px; color: #0f766e; margin-top: 0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>已完成拒收</h1>
    <p>我們已將貴公司（統編：${escapeHtml(taxId)}）及相關聯絡信箱自發送名單中移除，不會再寄送服務資訊打擾您。</p>
  </div>
</body>
</html>`);
    }

    // 5. GET /s -> 回傳行動版友善繁中問卷HTML
    if (path === '/s' && method === 'GET') {
      const taxId = (url.searchParams.get('id') || '').trim();
      const sig = (url.searchParams.get('sig') || '').trim();
      const valid = await verifyTaxIdSignature(env.LINK_SECRET, taxId, sig);
      if (!valid) {
        return htmlResponse(
          `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>連結無效</title></head><body><h2>問卷連結簽章無效</h2></body></html>`,
          400
        );
      }

      const actionUrl = `/s?id=${encodeURIComponent(taxId)}&sig=${encodeURIComponent(sig)}`;
      const unsubUrl = `/u?id=${encodeURIComponent(taxId)}&sig=${encodeURIComponent(sig)}`;
      const companyName = env.COMPANY_NAME || '沃客買創業投資股份有限公司';
      const companyPhone = env.COMPANY_PHONE || '請見信件聯絡資訊';

      return htmlResponse(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>新設企業需求問卷｜沃客買</title>
  <style>
    body { font-family: 'Microsoft JhengHei', system-ui, sans-serif; background: #f4f6f9; color: #1e293b; margin: 0; padding: 16px; line-height: 1.6; }
    .container { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #dce1e7; border-radius: 10px; padding: 24px 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    h1 { font-size: 20px; color: #1e3a5f; margin: 0 0 8px; }
    .q-group { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid #eef2f6; }
    .q-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; display: block; color: #1e3a5f; }
    .opt-label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 14px; cursor: pointer; }
    input[type="text"] { width: 100%; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; box-sizing: border-box; margin-top: 4px; }
    .consent-box { background: #f8fafc; border: 1px solid #cbd5e1; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
    button { width: 100%; background: #1e3a5f; color: #fff; border: none; padding: 12px; font-size: 16px; font-weight: 700; border-radius: 6px; cursor: pointer; }
    .notice { font-size: 12px; color: #64748b; margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>新創資源與營運支援需求問卷</h1>
    <p style="font-size:13px;color:#475569;">恭喜貴公司成立（統編：${escapeHtml(taxId)}）！請勾選貴公司目前可能感興趣的協助項目：</p>
    <form method="POST" action="${actionUrl}">
      <div class="q-group">
        <span class="q-title">1. 目前最需要的協助（可複選）</span>
        <label class="opt-label"><input type="checkbox" name="needs" value="找錢（貸款／補助／募資）"> 找錢（貸款／補助／募資）</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="公司登記地址／商務空間"> 公司登記地址／商務空間</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="會計記帳與稅務諮詢"> 會計記帳與稅務諮詢（由合格專業人員提供）</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="一般法律議題諮詢"> 一般法律議題諮詢及專業轉介</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="App創業陪跑"> App創業陪跑</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="線上課程製作與上架"> 線上課程製作與上架</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="品牌／媒體行銷"> 品牌／媒體行銷</label>
        <label class="opt-label"><input type="checkbox" name="needs" value="暫無需求"> 暫無需求</label>
      </div>

      <div class="q-group">
        <span class="q-title">2. 希望何時了解</span>
        <label class="opt-label"><input type="radio" name="timing" value="近期（1個月內）"> 近期（1個月內）</label>
        <label class="opt-label"><input type="radio" name="timing" value="1–3個月"> 1–3個月</label>
        <label class="opt-label"><input type="radio" name="timing" value="先收資料即可"> 先收資料即可</label>
      </div>

      <div class="q-group">
        <span class="q-title">3. 偏好回覆方式</span>
        <label class="opt-label"><input type="radio" name="contactPref" value="Email"> Email</label>
        <label class="opt-label"><input type="radio" name="contactPref" value="電話"> 電話</label>
        <label class="opt-label"><input type="radio" name="contactPref" value="不需要聯繫"> 不需要聯繫</label>
      </div>

      <div class="q-group">
        <span class="q-title">4. 聯絡資訊（選填）</span>
        <label style="display:block;font-size:13px;margin-bottom:8px;">公司名稱
          <input type="text" name="company" placeholder="貴公司名稱（選填）">
        </label>
        <label style="display:block;font-size:13px;">聯絡方式（Email 或電話與稱呼）
          <input type="text" name="contact" placeholder="例如：王先生 0912-345-678 或 email（選填）">
        </label>
      </div>

      <div class="consent-box">
        <label class="opt-label" style="margin:0;font-weight:600;">
          <input type="checkbox" name="consent" value="1">
          <span>5. 同意沃客買就本次詢問與我聯繫</span>
        </label>
      </div>

      <button type="submit">送出問卷回覆</button>
    </form>

    <div class="notice">
      <p style="margin:4px 0;"><strong>資料使用目的：</strong>僅回覆本次詢問，不作其他行銷用途。</p>
      <p style="margin:4px 0;"><strong>聯絡窗口：</strong>${escapeHtml(companyName)}（電話：${escapeHtml(companyPhone)}）</p>
      <p style="margin:4px 0;"><strong>保存原則：</strong>試點結束後一年內刪除。</p>
      <p style="margin:4px 0;"><strong>拒收方式：</strong>若不希望再收到相關資訊，請<a href="${unsubUrl}">點此前往拒收頁面</a>。</p>
    </div>
  </div>
</body>
</html>`);
    }

    // 6. POST /s -> 驗簽章；同一統編最多接受3次；寫 survey_responses；選「不需要聯繫」者同時寫 suppressions；顯示感謝頁
    if (path === '/s' && method === 'POST') {
      const taxId = (url.searchParams.get('id') || '').trim();
      const sig = (url.searchParams.get('sig') || '').trim();
      const valid = await verifyTaxIdSignature(env.LINK_SECRET, taxId, sig);
      if (!valid) {
        return htmlResponse(
          `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>連結無效</title></head><body><h2>問卷連結簽章無效</h2></body></html>`,
          400
        );
      }

      // 同一統編最多接受3次
      const countRow = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM survey_responses WHERE tax_id = ?'
      )
        .bind(taxId)
        .first<{ cnt: number }>();

      if (Number(countRow?.cnt || 0) >= 3) {
        return htmlResponse(
          `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>已達填寫上限</title></head><body style="font-family:sans-serif;padding:24px;text-align:center;"><h2>感謝您，同一統一編號問卷回覆最多接受 3 次。</h2></body></html>`,
          429
        );
      }

      let needs: string[] = [];
      let timing = '';
      let contactPref = '';
      let company = '';
      let contact = '';
      let consent = 0;

      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const json = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        needs = Array.isArray(json.needs)
          ? json.needs.map(String)
          : json.needs
            ? [String(json.needs)]
            : [];
        timing = String(json.timing || '');
        contactPref = String(json.contactPref || '');
        company = String(json.company || '');
        contact = String(json.contact || '');
        consent = json.consent ? 1 : 0;
      } else {
        const formData = await request.formData().catch(() => null);
        if (formData) {
          needs = formData.getAll('needs').map((v) => String(v));
          timing = String(formData.get('timing') || '');
          contactPref = String(formData.get('contactPref') || '');
          company = String(formData.get('company') || '');
          contact = String(formData.get('contact') || '');
          consent = formData.get('consent') === '1' ? 1 : 0;
        }
      }

      const nowIso = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO survey_responses (tax_id, needs, timing, contact_pref, company, contact, consent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          taxId,
          JSON.stringify(needs),
          timing,
          contactPref,
          company,
          contact,
          consent,
          nowIso
        )
        .run();

      // 選「不需要聯繫」者同時寫 suppressions
      if (contactPref === '不需要聯繫') {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
        )
          .bind(taxId, 'taxId', '問卷勾選不需要聯繫', 'survey', nowIso)
          .run();

        const sentEmails = await env.DB.prepare(
          'SELECT DISTINCT to_email FROM send_log WHERE tax_id = ?'
        )
            .bind(taxId)
            .all<{ to_email: string }>();

        for (const row of sentEmails.results || []) {
          const em = (row.to_email || '').trim().toLowerCase();
          if (em) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
            )
              .bind(em, 'email', '問卷勾選不需要聯繫', 'survey', nowIso)
              .run();
          }
        }
      }

      return htmlResponse(`<!doctype html>
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>感謝您的回覆｜沃客買</title>
  <style>
    body { font-family: 'Microsoft JhengHei', sans-serif; background: #f4f6f9; color: #1e293b; display: flex; justify-content: center; align-items: center; min-height: 90vh; margin: 0; padding: 16px; }
    .box { background: #fff; border: 1px solid #dce1e7; border-radius: 10px; max-width: 440px; width: 100%; padding: 28px 24px; text-align: center; }
    h1 { font-size: 20px; color: #1e3a5f; margin-top: 0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>感謝您的回覆！</h1>
    <p>我們已收到您的問卷回覆，將依您的偏好方式處理。</p>
  </div>
</body>
</html>`);
    }

    // 7. GET /sync?since=ISO -> 回傳 since 之後的 suppressions、survey_responses、email_events
    if (path === '/sync' && method === 'GET') {
      const since = (url.searchParams.get('since') || '').trim();
      const sinceParam = since || '1970-01-01T00:00:00.000Z';

      const [suppressionsRes, surveysRes, eventsRes] = await Promise.all([
        env.DB.prepare(
          'SELECT key, type, reason, source, created_at FROM suppressions WHERE created_at > ? ORDER BY created_at ASC'
        )
          .bind(sinceParam)
          .all(),
        env.DB.prepare(
          'SELECT id, tax_id, needs, timing, contact_pref, company, contact, consent, created_at FROM survey_responses WHERE created_at > ? ORDER BY created_at ASC'
        )
          .bind(sinceParam)
          .all(),
        env.DB.prepare(
          'SELECT id, resend_id, type, email, created_at FROM email_events WHERE created_at > ? ORDER BY created_at ASC'
        )
          .bind(sinceParam)
          .all(),
      ]);

      return jsonResponse(
        {
          suppressions: suppressionsRes.results || [],
          survey_responses: surveysRes.results || [],
          email_events: eventsRes.results || [],
          serverTime: new Date().toISOString(),
        },
        200,
        cors.headers
      );
    }

    // 8. GET /gcis?taxId= -> 以 GCIS_URL 代理查詢，回原始JSON
    if (path === '/gcis' && method === 'GET') {
      const taxId = (url.searchParams.get('taxId') || '').trim();
      if (!/^\d{8}$/.test(taxId)) {
        return jsonResponse(
          { ok: false, error: 'Invalid taxId (must be 8 digits)' },
          400,
          cors.headers
        );
      }

      const targetUrl = (env.GCIS_URL || '').replace(
        '{taxId}',
        encodeURIComponent(taxId)
      );
      const upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const rawText = await upstream.text();
      return new Response(rawText, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...cors.headers,
        },
      });
    }

    // 9. POST /resend-webhook -> 用 svix 驗章（RESEND_WEBHOOK_SECRET）
    if (path === '/resend-webhook' && method === 'POST') {
      if (!env.RESEND_WEBHOOK_SECRET) {
        return jsonResponse(
          { ok: false, error: 'Webhook secret not configured' },
          500
        );
      }

      const svixId = request.headers.get('svix-id') || '';
      const svixTimestamp = request.headers.get('svix-timestamp') || '';
      const svixSignature = request.headers.get('svix-signature') || '';
      const rawPayload = await request.text();

      let event: {
        type?: string;
        data?: {
          email_id?: string;
          to?: string | string[];
        };
      };

      try {
        const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
        event = wh.verify(rawPayload, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        }) as typeof event;
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid webhook signature' }, 400);
      }

      const eventType = event.type || 'unknown';
      const resendId = event.data?.email_id || '';
      const rawTo = event.data?.to;
      const email = (
        Array.isArray(rawTo) ? rawTo[0] || '' : rawTo || ''
      )
        .trim()
        .toLowerCase();
      const nowIso = new Date().toISOString();

      await env.DB.prepare(
        'INSERT INTO email_events (resend_id, type, email, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(resendId, eventType, email, nowIso)
        .run();

      // email.bounced、email.complained 寫 email_events 並把 email 加入 suppressions（reason 為 bounced/complained）
      if (
        email &&
        (eventType === 'email.bounced' || eventType === 'email.complained')
      ) {
        const reason =
          eventType === 'email.bounced' ? 'bounced' : 'complained';
        const source =
          eventType === 'email.bounced' ? 'bounce' : 'complaint';
        await env.DB.prepare(
          'INSERT OR REPLACE INTO suppressions (key, type, reason, source, created_at) VALUES (?, ?, ?, ?, ?)'
        )
          .bind(email, 'email', reason, source, nowIso)
          .run();
      }

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404, cors.headers);
  },
};
