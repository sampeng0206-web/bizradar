import Papa from 'papaparse';
import { Lead, LeadSource, OrgType } from '../types';
import { scoreLead } from './scoring';
import { DEFAULT_SERVICES, DEFAULT_WEIGHTS } from './services';

export const TAIWAN_CITIES = [
  '臺北市',
  '新北市',
  '基隆市',
  '桃園市',
  '新竹市',
  '新竹縣',
  '宜蘭縣',
  '苗栗縣',
  '臺中市',
  '彰化縣',
  '南投縣',
  '雲林縣',
  '嘉義市',
  '嘉義縣',
  '臺南市',
  '高雄市',
  '屏東縣',
  '花蓮縣',
  '臺東縣',
  '澎湖縣',
  '金門縣',
  '連江縣',
] as const;

export const REGION_GROUPS: Record<string, string[]> = {
  北部: [
    '臺北市',
    '新北市',
    '基隆市',
    '桃園市',
    '新竹市',
    '新竹縣',
    '宜蘭縣',
  ],
  中部: ['苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣'],
  南部: ['嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣'],
  東部: ['花蓮縣', '臺東縣'],
  離島: ['澎湖縣', '金門縣', '連江縣'],
};

export interface HeaderMapping {
  taxId?: string;
  name?: string;
  address?: string;
  representative?: string;
  capital?: string;
  setupDate?: string;
  orgType?: string;
}

export interface CsvErrorRow {
  fileName: string;
  rowNumber: number;
  taxId: string;
  name: string;
  reason: string;
  rawRow: Record<string, string>;
}

export function decodeCsvBuffer(buffer: ArrayBuffer): {
  text: string;
  encoding: 'utf-8' | 'big5';
} {
  let text = '';
  let encoding: 'utf-8' | 'big5' = 'utf-8';
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    text = utf8Decoder.decode(buffer);
  } catch {
    const big5Decoder = new TextDecoder('big5');
    text = big5Decoder.decode(buffer);
    encoding = 'big5';
  }
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return { text, encoding };
}

export function normalizeHeaderName(raw: string): string {
  return (raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]+/g, '') // 移除半形與全形空白
    .replace(/[（(].*?[)）]/g, '') // 移除括號與括號內補充說明
    .trim();
}

export function autoMapHeaders(headers: string[]): {
  mapping: HeaderMapping;
  missingRequired: ('taxId' | 'name' | 'address' | 'setupDate')[];
} {
  const mapping: HeaderMapping = {};

  for (const h of headers) {
    const norm = normalizeHeaderName(h);
    if (!mapping.taxId && (norm === '統一編號' || norm === '統編')) {
      mapping.taxId = h;
    } else if (
      !mapping.name &&
      (norm === '公司名稱' || norm === '商業名稱' || norm === '名稱')
    ) {
      mapping.name = h;
    } else if (
      !mapping.address &&
      (norm === '公司所在地' || norm === '商業地址' || norm === '地址' || norm === '所在地')
    ) {
      mapping.address = h;
    } else if (
      !mapping.representative &&
      (norm === '代表人' || norm === '負責人姓名' || norm === '負責人' || norm === '代表人姓名')
    ) {
      mapping.representative = h;
    } else if (
      !mapping.capital &&
      (norm === '資本額' || norm === '登記資本額' || norm === '資本總額' || norm === '實收資本額')
    ) {
      mapping.capital = h;
    } else if (
      !mapping.setupDate &&
      (norm === '核准設立日期' || norm === '設立核准日期' || norm === '設立日期' || norm === '設立日')
    ) {
      mapping.setupDate = h;
    } else if (
      !mapping.orgType &&
      (norm === '組織種類' || norm === '組織型態' || norm === '組織')
    ) {
      mapping.orgType = h;
    }
  }

  const required: ('taxId' | 'name' | 'address' | 'setupDate')[] = [
    'taxId',
    'name',
    'address',
    'setupDate',
  ];
  const missingRequired = required.filter((k) => !mapping[k]);

  return { mapping, missingRequired };
}

/**
 * 日期支援：1151015、991015、0991015、115/10/15、115-10-15、20261015、2026/10/15、2026-10-15
 * 民國+1911；回傳 yyyy-mm-dd 或 null
 */
export function parseTaiwanDate(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;

  let year: number;
  let month: number;
  let day: number;

  // 含分隔符號 / 或 - 或 .
  const sepMatch = /^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(str);
  if (sepMatch) {
    const y = Number(sepMatch[1]);
    year = y < 1900 ? y + 1911 : y;
    month = Number(sepMatch[2]);
    day = Number(sepMatch[3]);
  } else if (/^\d{6,8}$/.test(str)) {
    if (str.length === 8) {
      const first4 = Number(str.slice(0, 4));
      if (first4 >= 1900 && first4 <= 2100) {
        year = first4;
        month = Number(str.slice(4, 6));
        day = Number(str.slice(6, 8));
      } else {
        return null;
      }
    } else if (str.length === 7) {
      // e.g. 1151015 or 0991015
      year = Number(str.slice(0, 3)) + 1911;
      month = Number(str.slice(3, 5));
      day = Number(str.slice(5, 7));
    } else {
      // str.length === 6, e.g. 991015
      year = Number(str.slice(0, 2)) + 1911;
      month = Number(str.slice(2, 4));
      day = Number(str.slice(4, 6));
    }
  } else {
    return null;
  }

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1912 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  // 驗證實際曆法日期有效性 (例如 2/30 無效)
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * 統編補足8碼並驗證8位數字
 */
export function parseTaxId(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).trim().replace(/^['"]+|['"]+$/g, '');
  if (!cleaned || !/^\d{1,8}$/.test(cleaned)) return null;
  const padded = cleaned.padStart(8, '0');
  return /^\d{8}$/.test(padded) ? padded : null;
}

/**
 * 資本額去逗號轉數字
 */
export function parseCapital(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const cleaned = String(raw)
    .replace(/[,，\s元$NT＄]/gi, '')
    .trim();
  if (!cleaned) return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : 0;
}

/**
 * 地址解析：
 * 先移除開頭郵遞區號數字與「臺灣省」「福建省」前綴（金門、連江常為「福建省金門縣…」），
 * 「台」正規化為「臺」，再取縣市（正確區分新竹市/縣、嘉義市/縣），
 * 接著取第一個「區|鄉|鎮|市」為行政區；無法辨識標「未知縣市」
 */
export function parseTaiwanAddress(rawAddress: string | undefined): {
  normalizedAddress: string;
  city: string;
  district: string;
  isUnknownCity: boolean;
} {
  let addr = (rawAddress || '').trim();
  // 全形數字轉半形數字（針對開頭郵遞區號）
  addr = addr.replace(/^[０-９]+/, (m) =>
    Array.from(m)
      .map((ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .join('')
  );
  // 「台」正規化為「臺」
  addr = addr.replace(/台/g, '臺');

  // 移除開頭郵遞區號數字（3~6碼）與空白，以及「臺灣省」「福建省」前綴（可重複處理如「893 福建省金門縣...」）
  let prev = '';
  while (addr !== prev) {
    prev = addr;
    addr = addr
      .replace(/^\s*\d{3,6}\s*/, '')
      .replace(/^\s*(?:中華民國|臺灣省|福建省)\s*/, '');
  }

  let matchedCity = '';
  for (const city of TAIWAN_CITIES) {
    if (addr.startsWith(city)) {
      matchedCity = city;
      break;
    }
  }

  if (!matchedCity) {
    return {
      normalizedAddress: addr,
      city: '未知縣市',
      district: '',
      isUnknownCity: true,
    };
  }

  const rest = addr.slice(matchedCity.length).trim();
  const districtMatch = /^([^\d\s路街段巷弄號樓]{1,4}?(?:區|鄉|鎮|市))/.exec(
    rest
  );
  const district = districtMatch ? districtMatch[1] : '';

  return {
    normalizedAddress: addr,
    city: matchedCity,
    district,
    isUnknownCity: false,
  };
}

export function inferOrgType(
  name: string,
  rawOrgType?: string,
  source?: LeadSource
): OrgType {
  const org = (rawOrgType || '').trim();
  if (org.includes('股份有限公司')) return '股份有限公司';
  if (org.includes('有限公司')) return '有限公司';
  if (
    org.includes('獨資') ||
    org.includes('合夥') ||
    org.includes('行號') ||
    org.includes('商業')
  ) {
    return '行號';
  }

  const trimmedName = (name || '').trim();
  if (trimmedName.includes('股份有限公司')) return '股份有限公司';
  if (trimmedName.includes('有限公司')) return '有限公司';
  if (
    source === 'business' ||
    /(?:商行|企業社|工作室|實業社|工程行|資訊社|設計館|專賣店|號|行|社|店|坊|館|中心|部)$/.test(
      trimmedName
    )
  ) {
    return '行號';
  }
  return '其他';
}

export function inferLeadSource(
  headers: string[],
  orgType: OrgType,
  fileName: string
): LeadSource {
  const joinedHeaders = headers.join(',');
  if (
    joinedHeaders.includes('商業名稱') ||
    joinedHeaders.includes('商業地址') ||
    /商業|business|6668/i.test(fileName)
  ) {
    return 'business';
  }
  if (
    joinedHeaders.includes('公司名稱') ||
    joinedHeaders.includes('公司所在地') ||
    orgType === '股份有限公司' ||
    orgType === '有限公司'
  ) {
    return 'company';
  }
  return orgType === '行號' ? 'business' : 'company';
}

export interface ParsedCsvBatchResult {
  totalRead: number;
  leadsMap: Map<string, Lead>;
  errors: CsvErrorRow[];
}

export function parseCsvTextWithMapping(params: {
  csvText: string;
  fileName: string;
  mapping: HeaderMapping;
  importedAt?: string;
  suppressedKeys?: Set<string>;
  customerTaxIds?: Set<string>;
  referenceDate?: Date | string;
}): ParsedCsvBatchResult {
  const {
    csvText,
    fileName,
    mapping,
    importedAt = new Date().toISOString(),
    suppressedKeys = new Set<string>(),
    customerTaxIds = new Set<string>(),
    referenceDate,
  } = params;

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const headers = parsed.meta.fields || [];
  const rows = parsed.data || [];
  const leadsMap = new Map<string, Lead>();
  const errors: CsvErrorRow[] = [];
  let totalRead = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2; // 含表頭列

    const rawTaxId = mapping.taxId ? row[mapping.taxId] : '';
    const rawName = mapping.name ? row[mapping.name] : '';
    const rawAddress = mapping.address ? row[mapping.address] : '';
    const rawSetupDate = mapping.setupDate ? row[mapping.setupDate] : '';

    // 跳過完全空白或結尾統計列
    if (
      !rawTaxId?.trim() &&
      !rawName?.trim() &&
      !rawAddress?.trim() &&
      !rawSetupDate?.trim()
    ) {
      continue;
    }

    totalRead++;

    const taxId = parseTaxId(rawTaxId);
    if (!taxId) {
      errors.push({
        fileName,
        rowNumber,
        taxId: String(rawTaxId || ''),
        name: String(rawName || ''),
        reason: `統編格式錯誤（需為8位數字）：${rawTaxId || '空值'}`,
        rawRow: row,
      });
      continue;
    }

    const name = (rawName || '').trim();
    if (!name) {
      errors.push({
        fileName,
        rowNumber,
        taxId,
        name: '',
        reason: '缺少公司／商業名稱',
        rawRow: row,
      });
      continue;
    }

    const setupDate = parseTaiwanDate(rawSetupDate);
    if (!setupDate) {
      errors.push({
        fileName,
        rowNumber,
        taxId,
        name,
        reason: `設立日期格式錯誤：${rawSetupDate || '空值'}`,
        rawRow: row,
      });
      continue;
    }

    const addrInfo = parseTaiwanAddress(rawAddress);
    if (addrInfo.isUnknownCity) {
      errors.push({
        fileName,
        rowNumber,
        taxId,
        name,
        reason: `地址無法辨識縣市（已標記未知縣市）：${rawAddress || '空值'}`,
        rawRow: row,
      });
    }

    // 同批重複只留一筆
    if (leadsMap.has(taxId)) {
      continue;
    }

    const representative = (
      mapping.representative ? row[mapping.representative] || '' : ''
    ).trim();
    const capital = parseCapital(
      mapping.capital ? row[mapping.capital] : undefined
    );
    const rawOrg = mapping.orgType ? row[mapping.orgType] : undefined;
    const prelimOrgType = inferOrgType(name, rawOrg);
    const source = inferLeadSource(headers, prelimOrgType, fileName);
    const orgType = inferOrgType(name, rawOrg, source);

    const isExcluded =
      suppressedKeys.has(taxId) || customerTaxIds.has(taxId);
    const status = isExcluded ? '排除' : '新線索';

    const scoring = scoreLead({
      name,
      address: addrInfo.normalizedAddress,
      capital,
      setupDate,
      orgType,
      businessItems: [],
      status,
      services: DEFAULT_SERVICES,
      weights: DEFAULT_WEIGHTS,
      referenceDate,
    });

    const lead: Lead = {
      id: taxId,
      name,
      address: addrInfo.normalizedAddress,
      city: addrInfo.city,
      district: addrInfo.district,
      representative,
      capital,
      setupDate,
      source,
      sourceFile: fileName,
      importedAt,
      orgType,
      businessItems: [],
      email: '',
      phone: '',
      website: '',
      notes: '',
      demandFound: false,
      score: scoring.score,
      scoreBreakdown: scoring.scoreBreakdown,
      services: scoring.services,
      reasons: scoring.reasons,
      unknowns: scoring.unknowns,
      contactAdvice: scoring.contactAdvice,
      nextStep: scoring.nextStep,
      status,
      statusHistory: [
        {
          status,
          at: importedAt,
          note: isExcluded
            ? 'CSV 匯入時命中拒收或既有客戶名單，自動排除'
            : `由 ${fileName} 匯入`,
        },
      ],
      contactCount: 0,
    };

    leadsMap.set(taxId, lead);
  }

  return {
    totalRead,
    leadsMap,
    errors,
  };
}
