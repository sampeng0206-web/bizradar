export type LeadSource = 'company' | 'business';

export type OrgType = '股份有限公司' | '有限公司' | '行號' | '其他';

export type LeadStatus =
  | '新線索'
  | '待查核'
  | '待核准'
  | '已寄Email'
  | '已寄紙本'
  | '有興趣'
  | '未回覆'
  | '拒絕'
  | '退件'
  | '洽談中'
  | '已報價'
  | '成交'
  | '未成交'
  | '排除';

export interface BusinessItem {
  code: string;
  desc: string;
}

export interface StatusHistoryEntry {
  status: LeadStatus;
  at: string;
  note?: string;
}

export interface ScoreBreakdown {
  serviceFit: number;
  timeliness: number;
  reachability: number;
  demandSignal: number;
  total: number;
}

export interface Lead {
  id: string; // 統編，主鍵
  name: string;
  address: string;
  city: string;
  district: string;
  representative: string;
  capital: number; // 元
  setupDate: string; // yyyy-mm-dd
  source: LeadSource;
  sourceFile: string;
  importedAt: string;
  orgType: OrgType;
  businessItems: BusinessItem[];
  companyStatus?: string;
  enrichedAt?: string;
  email: string;
  phone: string;
  website: string;
  notes: string;
  demandFound: boolean;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  services: string[]; // 服務代碼陣列, e.g. ['A1', 'B2']
  reasons: string[];
  unknowns: string[];
  contactAdvice: string;
  nextStep: string;
  status: LeadStatus;
  statusHistory: StatusHistoryEntry[];
  lastContactAt?: string;
  contactCount: number;
}

export type SuppressionType = 'taxId' | 'email';
export type SuppressionSource =
  | 'manual'
  | 'unsubscribe'
  | 'survey'
  | 'bounce'
  | 'complaint'
  | 'status';

export interface Suppression {
  key: string; // 統編或小寫email
  type: SuppressionType;
  reason: string;
  source: SuppressionSource;
  at: string;
}

export interface Customer {
  taxId: string; // 既有客戶，排除用
  name?: string;
  at?: string;
}

export type SendChannel = 'email' | 'letter' | 'phone';
export type SendResult = 'sent' | 'failed' | 'returned' | 'bounced';

export interface SendRecord {
  id?: number; // ++id
  leadId: string;
  channel: SendChannel;
  at: string;
  subject: string;
  result: SendResult;
  resendId?: string;
  error?: string;
}

export interface SurveyRecord {
  id: number; // Worker回覆id
  taxId: string;
  needs: string[];
  timing: string;
  contactPref: string;
  company: string;
  contact: string;
  consent: boolean;
  at: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface ServiceDefinition {
  code: string;
  category: 'A' | 'B' | 'C';
  categoryLabel: string;
  name: string;
  shortPitch: string;
  enabled: boolean;
}

export interface ScoringWeights {
  serviceFitMax: number;
  timelinessMax: number;
  reachabilityMax: number;
  demandSignalMax: number;
}

export interface AppSettings {
  workerUrl: string;
  appToken: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyWebsite: string;
  emailSubjectTemplate: string;
  emailBodyTemplate: string;
  letterBodyTemplate: string;
  services: ServiceDefinition[];
  weights: ScoringWeights;
  lastSyncAt: string;
  newSurveyCount: number;
  gcisDirectFetchStatus?: 'untested' | 'ok' | 'cors_blocked';
}
