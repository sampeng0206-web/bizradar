import { AppSettings, ScoringWeights, ServiceDefinition } from '../types';

export const DEFAULT_SERVICES: ServiceDefinition[] = [
  {
    code: 'A1',
    category: 'A',
    categoryLabel: 'A 找錢',
    name: '政府補助計畫撰寫與申請輔導',
    shortPitch: '貴公司可能適合評估政府研發或創新補助計畫（提供計畫書撰寫與申請輔導）。',
    enabled: true,
  },
  {
    code: 'A2',
    category: 'A',
    categoryLabel: 'A 找錢',
    name: '中小企業信保基金保證創業貸款',
    shortPitch: '貴公司可能適合透過信保基金機制申請創業營運週轉資金輔導。',
    enabled: true,
  },
  {
    code: 'A3',
    category: 'A',
    categoryLabel: 'A 找錢',
    name: '青年創業及啟動金貸款',
    shortPitch: '若負責人年齡與條件合適，可能可評估青年創業及啟動金貸款方案。',
    enabled: true,
  },
  {
    code: 'A4',
    category: 'A',
    categoryLabel: 'A 找錢',
    name: '勞動部微型創業鳳凰貸款',
    shortPitch: '新設初期可能可評估勞動部微型創業鳳凰貸款與利息補貼資源。',
    enabled: true,
  },
  {
    code: 'A5',
    category: 'A',
    categoryLabel: 'A 找錢',
    name: '募資與股權投資準備',
    shortPitch: '針對成長型新創，可能適合進行商業模式梳理、募資簡報與股權投資準備。',
    enabled: true,
  },
  {
    code: 'B1',
    category: 'B',
    categoryLabel: 'B 公司後勤',
    name: '公司登記地址／商務中心',
    shortPitch: '初期營運可能有機會運用商務中心空間與公司登記地址支援方案。',
    enabled: true,
  },
  {
    code: 'B2',
    category: 'B',
    categoryLabel: 'B 公司後勤',
    name: '會計記帳與稅務諮詢（由合格專業人員提供）',
    shortPitch: '新設企業初期可能需要的會計記帳與稅務諮詢（由合格專業人員提供）。',
    enabled: true,
  },
  {
    code: 'B3',
    category: 'B',
    categoryLabel: 'B 公司後勤',
    name: '一般法律議題諮詢及專業轉介',
    shortPitch: '新創營運合約與股東協議等一般法律議題諮詢及專業轉介。',
    enabled: true,
  },
  {
    code: 'C1',
    category: 'C',
    categoryLabel: 'C 創造營收',
    name: 'App創業陪跑（七支App實作、Android與iOS雙平台上架經驗）',
    shortPitch: '若有數位產品規劃，可能適合 App創業陪跑（七支App實作、Android與iOS雙平台上架經驗）。',
    enabled: true,
  },
  {
    code: 'C2',
    category: 'C',
    categoryLabel: 'C 創造營收',
    name: '線上課程規劃製作上架',
    shortPitch: '知識與專業服務型團隊，可能適合透過線上課程規劃製作上架拓展營收來源。',
    enabled: true,
  },
  {
    code: 'C3',
    category: 'C',
    categoryLabel: 'C 創造營收',
    name: '品牌／新聞媒體整合行銷',
    shortPitch: '新品牌上市階段，可能適合評估品牌定位與新聞媒體整合行銷曝光。',
    enabled: true,
  },
];

export const DEFAULT_WEIGHTS: ScoringWeights = {
  serviceFitMax: 40,
  timelinessMax: 25,
  reachabilityMax: 20,
  demandSignalMax: 15,
};

export const DEFAULT_EMAIL_SUBJECT =
  '恭喜新設立｜新創資金與營運支援｜沃客買';

export const DEFAULT_EMAIL_BODY = `{{公司名稱}} {{負責人}} 您好：

恭喜貴公司近期成立！新創企業在起步階段往往需要資金規劃、後勤行政與業務拓展等多方資源支援。

依公開設立資料初步評估，貴公司可能適合參考以下資源與服務：
{{推薦服務}}

歡迎花一分鐘填寫需求問卷：{{問卷連結}}
也可以直接回信與我們聯絡。

若不希望再收到沃客買的服務資訊，請點此：{{拒收連結}}，或直接回信告知「拒收」。

本服務不保證任何政府補助、貸款或投資核准結果。

——
{{公司全名}}
地址：{{地址}}
電話：{{電話}}
官網：{{官網}}`;

export const DEFAULT_LETTER_BODY = `{{公司名稱}} 負責人 您好：

恭喜貴公司近期成立！新創企業在起步階段往往需要資金規劃、後勤行政與業務拓展等多方資源支援。

依公開設立資料初步評估，貴公司可能適合參考以下資源與服務：
{{推薦服務}}

歡迎掃描下方「需求問卷 QR Code」花一分鐘勾選貴公司感興趣的項目，或填寫背面回郵意向單與我們聯繫。

若不希望再收到沃客買的服務資訊，請掃描下方「拒收 QR Code」，或來電告知「拒收」（拒收專線：{{電話}}）。

本服務不保證任何政府補助、貸款或投資核准結果。

{{公司全名}} 敬上
地址：{{地址}}
電話：{{電話}}
官網：{{官網}}`;

export const DEFAULT_SETTINGS: AppSettings = {
  workerUrl: 'https://bizradar-mailer.sampeng-lifetrigger.workers.dev',
  appToken: '',
  companyName: '沃客買創業投資股份有限公司',
  companyAddress: '＿＿＿',
  companyPhone: '＿＿＿',
  companyWebsite: 'https://workmateiia.com',
  emailSubjectTemplate: DEFAULT_EMAIL_SUBJECT,
  emailBodyTemplate: DEFAULT_EMAIL_BODY,
  letterBodyTemplate: DEFAULT_LETTER_BODY,
  services: DEFAULT_SERVICES,
  weights: DEFAULT_WEIGHTS,
  lastSyncAt: '',
  newSurveyCount: 0,
  gcisDirectFetchStatus: 'untested',
};

export function getServiceMap(
  services: ServiceDefinition[] = DEFAULT_SERVICES
): Map<string, ServiceDefinition> {
  return new Map(services.map((s) => [s.code, s]));
}

export function formatRecommendedServicesPitch(
  serviceCodes: string[],
  services: ServiceDefinition[] = DEFAULT_SERVICES,
  maxCount = 3
): string {
  const map = getServiceMap(services);
  const enabledCodes = serviceCodes
    .map((c) => map.get(c))
    .filter((s): s is ServiceDefinition => Boolean(s && s.enabled))
    .slice(0, maxCount);

  if (enabledCodes.length === 0) {
    return '・新設企業營運支援、會計記帳與稅務諮詢（由合格專業人員提供）及相關創業輔導資源。';
  }

  return enabledCodes
    .map((s) => `・【${s.name}】${s.shortPitch}`)
    .join('\n');
}
