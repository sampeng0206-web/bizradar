import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BizRadarDB,
  canContactLead,
  updateLeadEditableFields,
  updateLeadStatus,
  upsertImportedLeads,
} from '../db/database';
import { evaluateServiceFit } from '../lib/businessRules';
import {
  autoMapHeaders,
  parseCapital,
  parseCsvTextWithMapping,
  parseTaiwanAddress,
  parseTaiwanDate,
  parseTaxId,
} from '../lib/csvParser';
import { enrichSingleLeadWithGcis } from '../lib/gcis';
import { scoreLead } from '../lib/scoring';
import { DEFAULT_SERVICES } from '../lib/services';

describe('第一部分：日期解析、地址解析（含金門／連江／澎湖）、評分、營業項目規則與 IndexedDB', () => {
  describe('日期解析 parseTaiwanDate', () => {
    it('支援民國與西元多種格式並正確轉換為 yyyy-mm-dd', () => {
      expect(parseTaiwanDate('1151015')).toBe('2026-10-15');
      expect(parseTaiwanDate('991015')).toBe('2010-10-15');
      expect(parseTaiwanDate('0991015')).toBe('2010-10-15');
      expect(parseTaiwanDate('115/10/15')).toBe('2026-10-15');
      expect(parseTaiwanDate('115-10-15')).toBe('2026-10-15');
      expect(parseTaiwanDate('20261015')).toBe('2026-10-15');
      expect(parseTaiwanDate('2026/10/15')).toBe('2026-10-15');
      expect(parseTaiwanDate('2026-10-15')).toBe('2026-10-15');
      expect(parseTaiwanDate('115/1/5')).toBe('2026-01-05');
    });

    it('無效日期應回傳 null', () => {
      expect(parseTaiwanDate('')).toBeNull();
      expect(parseTaiwanDate('1151340')).toBeNull();
      expect(parseTaiwanDate('2026/02/30')).toBeNull();
      expect(parseTaiwanDate('invalid')).toBeNull();
    });
  });

  describe('統編與資本額解析', () => {
    it('統編自動補足8碼並驗證8位數字', () => {
      expect(parseTaxId('12345678')).toBe('12345678');
      expect(parseTaxId('1234567')).toBe('01234567');
      expect(parseTaxId(' 20828393 ')).toBe('20828393');
      expect(parseTaxId('1234ABCD')).toBeNull();
      expect(parseTaxId('123456789')).toBeNull();
    });

    it('資本額去逗號轉數字', () => {
      expect(parseCapital('1,000,000')).toBe(1000000);
      expect(parseCapital('500,000元')).toBe(500000);
      expect(parseCapital('')).toBe(0);
    });
  });

  describe('地址解析 parseTaiwanAddress（含金門、連江、澎湖、新竹市/縣、嘉義市/縣）', () => {
    it('正確移除郵遞區號與臺灣省／福建省前綴，並將「台」正規化為「臺」', () => {
      const kinmen = parseTaiwanAddress('893福建省金門縣金城鎮民生路10號');
      expect(kinmen.city).toBe('金門縣');
      expect(kinmen.district).toBe('金城鎮');
      expect(kinmen.isUnknownCity).toBe(false);

      const lianjiang = parseTaiwanAddress('209 福建省連江縣南竿鄉介壽村15號');
      expect(lianjiang.city).toBe('連江縣');
      expect(lianjiang.district).toBe('南竿鄉');
      expect(lianjiang.isUnknownCity).toBe(false);

      const penghu = parseTaiwanAddress('880臺灣省澎湖縣馬公市光復路88號');
      expect(penghu.city).toBe('澎湖縣');
      expect(penghu.district).toBe('馬公市');
      expect(penghu.isUnknownCity).toBe(false);

      const taipei = parseTaiwanAddress('106台北市大安區敦化南路二段99號10樓');
      expect(taipei.city).toBe('臺北市');
      expect(taipei.district).toBe('大安區');
      expect(taipei.normalizedAddress).toBe(
        '臺北市大安區敦化南路二段99號10樓'
      );
    });

    it('正確區分新竹市／新竹縣、嘉義市／嘉義縣', () => {
      const hsinchuCity = parseTaiwanAddress('300新竹市東區光復路二段101號');
      expect(hsinchuCity.city).toBe('新竹市');
      expect(hsinchuCity.district).toBe('東區');

      const hsinchuCounty = parseTaiwanAddress(
        '302台灣省新竹縣竹北市光明六路10號'
      );
      expect(hsinchuCounty.city).toBe('新竹縣');
      expect(hsinchuCounty.district).toBe('竹北市');

      const chiayiCity = parseTaiwanAddress('600嘉義市西區中山路100號');
      expect(chiayiCity.city).toBe('嘉義市');
      expect(chiayiCity.district).toBe('西區');

      const chiayiCounty = parseTaiwanAddress('612嘉義縣太保市祥和一路東段1號');
      expect(chiayiCounty.city).toBe('嘉義縣');
      expect(chiayiCounty.district).toBe('太保市');
    });

    it('無法辨識時標為「未知縣市」', () => {
      const unknown = parseTaiwanAddress('某工業園區測試路1號');
      expect(unknown.city).toBe('未知縣市');
      expect(unknown.district).toBe('');
      expect(unknown.isUnknownCity).toBe(true);
    });
  });

  describe('營業項目規則與服務適配 evaluateServiceFit', () => {
    it('科技研發型營業項目 I301/IG/F118/F218 應加 15 分並推薦 A1、A5、C1', () => {
      const res = evaluateServiceFit({
        name: '山海興業有限公司',
        capital: 1_000_000, // 50萬-500萬 +10 (A1, A2, B2)
        orgType: '有限公司',
        businessItems: [{ code: 'I301010', desc: '資訊軟體服務業' }],
      });
      // 15 (I301) + 10 (50萬-500萬) + 5 (B2基本) = 30
      expect(res.cappedScore).toBe(30);
      expect(res.services).toEqual(
        expect.arrayContaining(['A1', 'A5', 'C1', 'A2', 'B2'])
      );
      expect(res.reasons).toContain(
        '依營業項目，可能屬科技／研發型新創，適合補助計畫與募資'
      );
    });

    it('有實質營業項目時，名稱關鍵字減半計分；ZZ99999 不加不扣', () => {
      const withoutItems = evaluateServiceFit({
        name: '未來AI智能科技有限公司',
        capital: 300_000, // <=50萬 +10
        orgType: '有限公司',
        businessItems: [{ code: 'ZZ99999', desc: '除許可業務外...' }],
      });
      // 15 (名稱科技) + 10 (<=50萬) + 5 (B2) = 30
      expect(withoutItems.cappedScore).toBe(30);

      const withItems = evaluateServiceFit({
        name: '未來AI智能科技有限公司',
        capital: 300_000,
        orgType: '有限公司',
        businessItems: [{ code: 'C801010', desc: '基本化學工業' }], // C開頭 +10
      });
      // 10 (C開頭) + 7.5 (名稱科技減半) + 10 (<=50萬) + 5 (B2) = 32.5 -> round 33
      expect(withItems.cappedScore).toBe(33);
    });

    it('營造 E 開頭、金融不動產 H 開頭應扣 10 分；設定中關閉的服務不得推薦', () => {
      const customServices = DEFAULT_SERVICES.map((s) =>
        s.code === 'B2' ? { ...s, enabled: false } : s
      );
      const res = evaluateServiceFit({
        name: '大發建設開發股份有限公司',
        capital: 10_000_000,
        orgType: '股份有限公司',
        businessItems: [{ code: 'E101011', desc: '綜合營造業' }],
        enabledServices: customServices,
      });
      // E開頭 -10, 名稱建設減半 -5, >500萬 +8, B2 +5 => -2 -> capped at 0
      expect(res.cappedScore).toBe(0);
      expect(res.services).not.toContain('B2');
    });
  });

  describe('總分計算 scoreLead 與合規語氣檢查', () => {
    it('總分100 = 服務適配40 + 時間性25 + 可接觸20 + 需求訊號15，且文字不含禁用詞', () => {
      const result = scoreLead({
        name: '星雲數位軟體股份有限公司',
        address: '臺北市信義區松仁路100號8樓',
        capital: 6_000_000,
        setupDate: '2026-10-01',
        orgType: '股份有限公司',
        businessItems: [
          { code: 'I301010', desc: '資訊軟體服務業' },
          { code: 'I401010', desc: '一般廣告服務業' },
        ],
        email: 'hi@nebula.tw',
        website: 'https://nebula.tw',
        notes: '正在招募工程師',
        demandFound: true,
        referenceDate: '2026-11-03', // 33天 -> <=60天 (25分)
      });

      expect(result.scoreBreakdown.timeliness).toBe(25);
      expect(result.scoreBreakdown.reachability).toBe(20); // email +12, 號 +8
      expect(result.scoreBreakdown.demandSignal).toBe(15); // 上限 15
      expect(result.scoreBreakdown.serviceFit).toBeLessThanOrEqual(40);
      expect(result.score).toBe(
        result.scoreBreakdown.serviceFit +
          result.scoreBreakdown.timeliness +
          result.scoreBreakdown.reachability +
          result.scoreBreakdown.demandSignal
      );
      expect(result.contactAdvice).toBe('Email（人工核准後寄送）');
      expect(result.unknowns).not.toContain('無公開商務Email');

      // 驗證所有產出文字禁止出現「符合資格」或「保證」
      const allTexts = [
        ...result.reasons,
        ...result.unknowns,
        result.contactAdvice,
        result.nextStep,
      ].join(' ');
      expect(allTexts).not.toContain('符合資格');
      expect(allTexts).not.toContain('保證');
    });
  });

  describe('CSV 批次匯入、去重、contactCount 上限與 GCIS 補強', () => {
    let testDb: BizRadarDB;

    beforeEach(async () => {
      testDb = new BizRadarDB(`TestDB_${Date.now()}_${Math.random()}`);
    });

    it('支援表頭自動對應、同批去重、既有統編更新但保留 status/email/notes、拒絕自動加入 suppressions、contactCount 上限2次', async () => {
      const csvText = `統一編號,公司名稱,公司所在地,代表人,資本額,核准設立日期
20828393,沃客買測試科技有限公司,106台北市大安區忠孝東路四段1號,王小明,"1,000,000",1151015
20828393,沃客買測試科技有限公司(重複列),106台北市大安區忠孝東路四段1號,王小明,"1,000,000",1151015
87654321,金門海風文創有限公司,893福建省金門縣金城鎮民生路2號,李大華,"500,000",115/09/20`;

      const { mapping, missingRequired } = autoMapHeaders([
        '統一編號',
        '公司名稱',
        '公司所在地',
        '代表人',
        '資本額',
        '核准設立日期',
      ]);
      expect(missingRequired).toHaveLength(0);

      const batch1 = parseCsvTextWithMapping({
        csvText,
        fileName: 'test_oct.csv',
        mapping,
        referenceDate: '2026-11-03',
      });
      expect(batch1.totalRead).toBe(3);
      expect(batch1.leadsMap.size).toBe(2); // 同批重複只留一筆

      const sum1 = await upsertImportedLeads(batch1.leadsMap, testDb);
      expect(sum1.added).toBe(2);
      expect(sum1.updated).toBe(0);

      // 編輯 email 與 notes 並變更狀態為「待核准」
      await updateLeadEditableFields(
        '20828393',
        { email: 'Sales@Test.com', notes: '重點潛客', demandFound: true },
        testDb
      );
      await updateLeadStatus('20828393', '待核准', '人工審核通過', testDb);

      // 再次匯入更新地址，確認保留 status、email、notes
      const csvText2 = `統一編號,公司名稱,公司所在地,代表人,資本額,核准設立日期
20828393,沃客買測試科技有限公司,110台北市信義區信義路五段7號,王小明,"2,000,000",1151015`;
      const batch2 = parseCsvTextWithMapping({
        csvText: csvText2,
        fileName: 'test_nov.csv',
        mapping,
        referenceDate: '2026-11-03',
      });
      const sum2 = await upsertImportedLeads(batch2.leadsMap, testDb);
      expect(sum2.added).toBe(0);
      expect(sum2.updated).toBe(1);

      const saved = await testDb.leads.get('20828393');
      expect(saved?.status).toBe('待核准');
      expect(saved?.email).toBe('Sales@Test.com');
      expect(saved?.notes).toBe('重點潛客');
      expect(saved?.capital).toBe(2000000);

      // 驗證 contactCount 上限 (最多2次: 0, 1 可寄; 2 不可寄)
      expect((await canContactLead(saved!, testDb)).allowed).toBe(true);
      await testDb.leads.update('20828393', { contactCount: 2 });
      const afterTwoContacts = await testDb.leads.get('20828393');
      const check2 = await canContactLead(afterTwoContacts!, testDb);
      expect(check2.allowed).toBe(false);
      expect(check2.reason).toContain('上限');

      // 驗證改為「拒絕」時自動把統編與小寫 email 加入 suppressions
      await updateLeadStatus('20828393', '拒絕', '客戶來信拒收', testDb);
      const supTax = await testDb.suppressions.get('20828393');
      const supEmail = await testDb.suppressions.get('sales@test.com');
      expect(supTax).toBeDefined();
      expect(supEmail).toBeDefined();
    });

    it('GCIS 補抓若 companyStatus 非「核准設立」應自動標為排除，理由「公司現況非核准設立」', async () => {
      const csvText = `統一編號,公司名稱,公司所在地,代表人,資本額,核准設立日期
11223344,測試解散有限公司,100台北市中正區重慶南路一段1號,張三,500000,1151001`;
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
        fileName: 'company.csv',
        mapping,
      });
      await upsertImportedLeads(batch.leadsMap, testDb);
      const lead = await testDb.leads.get('11223344');

      const mockFetch = async () =>
        new Response(
          JSON.stringify([
            {
              Business_Accounting_NO: '11223344',
              Company_Status_Desc: '解散',
              Cmp_Business: [
                { Business_Item: 'I301010', Business_Item_Desc: '資訊軟體服務業' },
              ],
            },
          ]),
          { status: 200 }
        );

      const { updatedLead } = await enrichSingleLeadWithGcis(
        lead!,
        testDb,
        mockFetch as unknown as typeof fetch
      );
      expect(updatedLead.status).toBe('排除');
      expect(updatedLead.reasons).toContain('公司現況非核准設立');
    });
  });
});
