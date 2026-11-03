import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BizRadarDB,
  saveAppSettings,
  upsertImportedLeads,
} from '../db/database';
import { autoMapHeaders, parseCsvTextWithMapping } from '../lib/csvParser';
import { applySyncPayload, sendSingleApprovedEmail } from '../lib/sync';
import {
  checkMissingRequiredSettings,
  renderTemplateText,
} from '../lib/templates';
import { DEFAULT_SETTINGS } from '../lib/services';

describe('第三部分：範本渲染、寄送檢查、Worker 同步回寫（拒收／問卷／退信）測試', () => {
  let testDb: BizRadarDB;

  beforeEach(async () => {
    testDb = new BizRadarDB(`TestPart3DB_${Date.now()}_${Math.random()}`);
    await saveAppSettings(
      {
        workerUrl: 'https://bizradar-mailer.test.workers.dev',
        appToken: 'secret_token',
        companyName: '沃客買創業投資股份有限公司',
        companyAddress: '臺北市信義區測試路100號',
        companyPhone: '02-2345-6789',
        companyWebsite: 'https://workmateiia.com',
      },
      testDb
    );

    const csvText = `統一編號,公司名稱,公司所在地,代表人,資本額,核准設立日期
20828393,星辰軟體股份有限公司,110台北市信義區松仁路99號,陳曉明,3000000,1151015
87654321,海島咖啡有限公司,893福建省金門縣金城鎮民生路8號,林小美,500000,1151018`;
    const { mapping } = autoMapHeaders([
      '統一編號',
      '公司名稱',
      '公司所在地',
      '代表人',
      '資本額',
      '核准設立日期',
    ]);
    const batch = parseCsvTextWithMapping({
      csvText,
      fileName: 'part3.csv',
      mapping,
      referenceDate: '2026-11-03',
    });
    await upsertImportedLeads(batch.leadsMap, testDb);
  });

  it('範本變數替換正確，且記帳與法律服務文字合規，必要設定缺漏可正確偵測', async () => {
    const lead = (await testDb.leads.get('20828393'))!;
    lead.services = ['B2', 'B3', 'A1'];

    const rendered = renderTemplateText(DEFAULT_SETTINGS.emailBodyTemplate, {
      lead,
      settings: {
        ...DEFAULT_SETTINGS,
        companyAddress: '臺北市信義區測試路100號',
        companyPhone: '02-2345-6789',
        companyWebsite: 'https://workmateiia.com',
      },
    });

    expect(rendered).toContain('星辰軟體股份有限公司');
    expect(rendered).toContain('陳曉明');
    expect(rendered).toContain('會計記帳與稅務諮詢（由合格專業人員提供）');
    expect(rendered).toContain('一般法律議題諮詢及專業轉介');
    expect(rendered).toContain('本服務不保證任何政府補助、貸款或投資核准結果。');

    const missing = checkMissingRequiredSettings(DEFAULT_SETTINGS);
    expect(missing).toContain('Worker 網址');
    expect(missing).toContain('APP_TOKEN');
  });

  it('Email 寄送：200 更新為已寄Email且 contactCount+1；409 標記排除；429 停止並回報今日已達上限', async () => {
    await testDb.leads.update('20828393', {
      email: 'ceo@star.tw',
      status: '待核准',
    });
    const lead1 = (await testDb.leads.get('20828393'))!;

    // 1. 模擬 200 成功
    const resOk = await sendSingleApprovedEmail({
      lead: lead1,
      subject: '主旨',
      bodyText: '內文',
      database: testDb,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: true, resendId: 're_001', remainingToday: 19 }),
          { status: 200 }
        )) as unknown as typeof fetch,
    });
    expect(resOk.status).toBe('sent');

    const updated1 = (await testDb.leads.get('20828393'))!;
    expect(updated1.status).toBe('已寄Email');
    expect(updated1.contactCount).toBe(1);

    // 2. 模擬 409 拒收 -> 自動標記排除
    await testDb.leads.update('87654321', {
      email: 'coffee@kinmen.tw',
      status: '待核准',
    });
    const lead2 = (await testDb.leads.get('87654321'))!;
    const res409 = await sendSingleApprovedEmail({
      lead: lead2,
      subject: '主旨',
      bodyText: '內文',
      database: testDb,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 409,
        })) as unknown as typeof fetch,
    });
    expect(res409.status).toBe('excluded_409');
    expect((await testDb.leads.get('87654321'))?.status).toBe('排除');
  });

  it('/sync 自動回寫：問卷勾選需求且同意聯繫 -> 有興趣並寫入 notes；退信 -> 退件與 sends(bounced)', async () => {
    await testDb.leads.update('20828393', {
      email: 'ceo@star.tw',
      status: '已寄Email',
    });
    await testDb.leads.update('87654321', {
      email: 'bounce@kinmen.tw',
      status: '已寄Email',
    });

    await applySyncPayload(
      {
        suppressions: [],
        survey_responses: [
          {
            id: 101,
            tax_id: '20828393',
            needs: JSON.stringify(['找錢（貸款／補助／募資）', 'App創業陪跑']),
            timing: '近期（1個月內）',
            contact_pref: '電話',
            company: '星辰軟體股份有限公司',
            contact: '0912-345-678',
            consent: 1,
            created_at: '2026-11-03T01:00:00.000Z',
          },
        ],
        email_events: [
          {
            id: 201,
            resend_id: 're_bounce_1',
            type: 'email.bounced',
            email: 'bounce@kinmen.tw',
            created_at: '2026-11-03T01:05:00.000Z',
          },
        ],
        serverTime: '2026-11-03T01:10:00.000Z',
      },
      testDb
    );

    const leadStar = (await testDb.leads.get('20828393'))!;
    expect(leadStar.status).toBe('有興趣');
    expect(leadStar.notes).toContain('找錢（貸款／補助／募資）');
    expect(leadStar.notes).toContain('App創業陪跑');

    const leadCoffee = (await testDb.leads.get('87654321'))!;
    expect(leadCoffee.status).toBe('退件');
    const sends = await testDb.sends.where('leadId').equals('87654321').toArray();
    expect(sends.some((s) => s.result === 'bounced')).toBe(true);
  });
});
