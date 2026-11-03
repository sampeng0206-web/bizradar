import { BusinessItem, LeadStatus, OrgType, ServiceDefinition } from '../types';
import { DEFAULT_SERVICES } from './services';

export interface RuleEvaluationInput {
  name: string;
  capital: number;
  orgType: OrgType;
  businessItems: BusinessItem[];
  enabledServices?: ServiceDefinition[];
}

export interface ServiceFitResult {
  rawScore: number;
  cappedScore: number;
  services: string[];
  reasons: string[];
}

const TECH_CODES = ['I301', 'I302', 'I303', 'IG', 'F118', 'F218'];
const CULT_DESIGN_CODES = ['I103', 'I401', 'IZ12'];

const TECH_KEYWORDS_REGEX =
  /科技|資訊|數位|軟體|網路|智能|智慧|AI|雲端|生技|生醫|醫材|能源|綠能|創新|電商|電子商務|平台/i;
const FOOD_RETAIL_KEYWORDS_REGEX =
  /餐飲|餐廳|美食|咖啡|烘焙|小吃|飲料|茶|食品|商行|工作室|美容|美髮|服飾/;
const CULT_MEDIA_KEYWORDS_REGEX =
  /文創|設計|影音|影像|教育|補習|文化|顧問|行銷|傳播|媒體|出版/;
const NEGATIVE_KEYWORDS_REGEX = /控股|投資|建設|營造|不動產|開發/;

export function evaluateServiceFit(
  input: RuleEvaluationInput,
  maxScore = 40
): ServiceFitResult {
  const servicesSet = new Set<string>();
  const reasons: string[] = [];
  let rawScore = 0;

  const items = Array.isArray(input.businessItems) ? input.businessItems : [];
  const normalizedCodes = items
    .map((b) => (b.code || '').trim().toUpperCase())
    .filter(Boolean);

  // 判斷是否有實質營業項目（排除單純 ZZ99999）
  const hasEffectiveBusinessItems = normalizedCodes.some(
    (code) => code !== 'ZZ99999'
  );

  // 1. 營業項目代碼規則
  if (normalizedCodes.length > 0) {
    // I301、I302、I303、IG（生技）、F118、F218（資訊軟體批發零售）→ A1、A5、C1 +15
    if (
      normalizedCodes.some((code) =>
        TECH_CODES.some((prefix) => code.startsWith(prefix))
      )
    ) {
      rawScore += 15;
      ['A1', 'A5', 'C1'].forEach((s) => servicesSet.add(s));
      reasons.push(
        '依營業項目，可能屬科技／研發型新創，適合補助計畫與募資'
      );
    }

    // F501（餐飲）→ A3、A4、B2 +12
    if (normalizedCodes.some((code) => code.startsWith('F501'))) {
      rawScore += 12;
      ['A3', 'A4', 'B2'].forEach((s) => servicesSet.add(s));
      reasons.push(
        '依營業項目（餐飲相關），可能適合評估青年／微型創業貸款與記帳稅務諮詢'
      );
    }

    // F2 開頭（零售，排除已歸類為資訊軟體零售之 F218）→ A3、A4、B2 +10
    if (
      normalizedCodes.some(
        (code) => code.startsWith('F2') && !code.startsWith('F218')
      )
    ) {
      rawScore += 10;
      ['A3', 'A4', 'B2'].forEach((s) => servicesSet.add(s));
      reasons.push(
        '依營業項目（零售相關），可能適合評估創業貸款與記帳稅務諮詢'
      );
    }

    // J 開頭（文化休閒）、I103（管理顧問）、I401（廣告）、IZ12（設計）→ C2、C3 +10
    if (
      normalizedCodes.some(
        (code) =>
          code.startsWith('J') ||
          CULT_DESIGN_CODES.some((prefix) => code.startsWith(prefix))
      )
    ) {
      rawScore += 10;
      ['C2', 'C3'].forEach((s) => servicesSet.add(s));
      reasons.push(
        '依營業項目（文化休閒／顧問／廣告／設計），可能適合線上課程與品牌媒體行銷'
      );
    }

    // C 開頭（製造）→ A1、A2 +10
    if (normalizedCodes.some((code) => code.startsWith('C'))) {
      rawScore += 10;
      ['A1', 'A2'].forEach((s) => servicesSet.add(s));
      reasons.push(
        '依營業項目（製造相關），可能適合評估政府補助計畫與創業貸款輔導'
      );
    }

    // E 開頭（營造）、H 開頭（金融保險不動產）→ −10
    if (
      normalizedCodes.some(
        (code) => code.startsWith('E') || code.startsWith('H')
      )
    ) {
      rawScore -= 10;
      reasons.push(
        '依營業項目（營造或金融不動產相關），一般新創輔導服務適配度可能較低'
      );
    }

    // ZZ99999 不加不扣
  }

  // 2. 名稱關鍵字規則（無營業項目時使用，有營業項目時減半計分）
  const keywordMultiplier = hasEffectiveBusinessItems ? 0.5 : 1;
  const name = input.name || '';

  if (TECH_KEYWORDS_REGEX.test(name)) {
    rawScore += 15 * keywordMultiplier;
    ['A1', 'A5', 'C1'].forEach((s) => servicesSet.add(s));
    reasons.push(
      hasEffectiveBusinessItems
        ? '依公司名稱關鍵字（輔助判斷），可能具科技／數位／創新屬性'
        : '依名稱關鍵字，可能屬科技／數位／研發型新創，適合補助計畫、募資與App陪跑'
    );
  }

  if (FOOD_RETAIL_KEYWORDS_REGEX.test(name)) {
    rawScore += 12 * keywordMultiplier;
    ['A3', 'A4', 'B2'].forEach((s) => servicesSet.add(s));
    reasons.push(
      hasEffectiveBusinessItems
        ? '依公司名稱關鍵字（輔助判斷），可能具民生餐飲或商業服務屬性'
        : '依名稱關鍵字，可能屬餐飲／民生服務型事業，適合青創／鳳凰貸款與記帳諮詢'
    );
  }

  if (CULT_MEDIA_KEYWORDS_REGEX.test(name)) {
    rawScore += 10 * keywordMultiplier;
    ['C2', 'C3'].forEach((s) => servicesSet.add(s));
    reasons.push(
      hasEffectiveBusinessItems
        ? '依公司名稱關鍵字（輔助判斷），可能具文創、顧問或媒體行銷屬性'
        : '依名稱關鍵字，可能屬文創／設計／顧問／媒體領域，適合線上課程與品牌行銷'
    );
  }

  if (NEGATIVE_KEYWORDS_REGEX.test(name)) {
    rawScore -= 10 * keywordMultiplier;
    reasons.push('依名稱關鍵字（控股／投資／建設／不動產），適配度可能較低');
  }

  // 3. 資本額與組織規則
  const capital = Number.isFinite(input.capital) ? input.capital : 0;
  if (capital <= 500_000) {
    rawScore += 10;
    ['A3', 'A4', 'B1'].forEach((s) => servicesSet.add(s));
    reasons.push(
      '資本額於 50 萬以下，可能適合評估青創／微型創業貸款及商務中心登記地址'
    );
  } else if (capital > 500_000 && capital <= 5_000_000) {
    rawScore += 10;
    ['A1', 'A2', 'B2'].forEach((s) => servicesSet.add(s));
    reasons.push(
      '資本額於 50 萬至 500 萬區間，可能適合評估政府補助計畫、創業貸款與記帳諮詢'
    );
  }

  if (capital > 5_000_000 || input.orgType === '股份有限公司') {
    rawScore += 8;
    ['A1', 'A5'].forEach((s) => servicesSet.add(s));
    reasons.push(
      '資本額逾 500 萬或屬股份有限公司型態，可能適合評估政府補助與募資股權規劃'
    );
  }

  // 4. 所有新設企業加 B2 +5
  rawScore += 5;
  servicesSet.add('B2');
  reasons.push(
    '新設企業初期可能皆有會計記帳與稅務諮詢（由合格專業人員提供）需求'
  );

  // 5. 過濾設定中關閉的服務
  const serviceDefs = input.enabledServices ?? DEFAULT_SERVICES;
  const enabledCodes = new Set(
    serviceDefs.filter((s) => s.enabled).map((s) => s.code)
  );
  const filteredServices = Array.from(servicesSet).filter((code) =>
    enabledCodes.has(code)
  );

  const cappedScore = Math.max(0, Math.min(maxScore, Math.round(rawScore)));

  return {
    rawScore,
    cappedScore,
    services: filteredServices,
    reasons,
  };
}

export function getNextStepAdvice(status: LeadStatus, hasEmail: boolean): string {
  switch (status) {
    case '新線索':
      return '建議先檢視營業項目與基本資料，搜尋公開官網或聯絡資訊後改為「待查核」或「待核准」';
    case '待查核':
      return '建議人工確認負責人與營業項目是否可能適配，確認無誤後移入「待核准」佇列';
    case '待核准':
      return hasEmail
        ? '已備妥公開商務 Email，建議於核准佇列預覽信件內容後人工核准寄送'
        : '尚無公開 Email，建議於核准佇列預覽紙本開發信與 QR Code 後加入列印批次';
    case '已寄Email':
      return '已寄出開發信，建議靜候問卷回覆；若滿 10 天未回覆且分數達標可能安排一次人工跟進';
    case '已寄紙本':
      return '已寄出紙本信，建議留意是否有回郵意向單、線上問卷回覆或郵局退件';
    case '有興趣':
      return '客戶可能對服務感興趣，建議儘速依偏好聯繫方式安排專人初步接洽並改為「洽談中」';
    case '未回覆':
      return '首次聯繫後尚未回覆，若接觸次數未達上限可能評估安排最後一次溫和跟進';
    case '洽談中':
      return '目前接洽訪談中，建議釐清客戶具體需求項目與時程，準備提供合作建議與報價';
    case '已報價':
      return '已提供報價方案，建議追蹤客戶內部評估進度並適時協助解答疑問';
    case '成交':
      return '已完成簽約合作，建議移交交付團隊並將統編加入既有客戶排除名單';
    case '未成交':
      return '本次未能合作，已記錄未成交原因，未來若有新需求可能再行評估';
    case '拒絕':
      return '對方已表達拒收或無需求，系統已自動列入拒收名單，請勿再次聯繫';
    case '退件':
      return '信件或郵件發生退回，建議核實地址或聯絡管道，避免重複寄送';
    case '排除':
      return '此名單屬於既有客戶、拒收名單或公司現況非核准設立，系統已排除開發';
    default:
      return '建議依標準流程檢視資料並評估下一步聯繫方式';
  }
}
