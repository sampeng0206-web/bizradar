import { BizRadarDB, db, getAppSettings, saveAppSettings } from '../db/database';
import { BusinessItem, Lead } from '../types';
import { applyScoringToLead } from './scoring';

export const GCIS_COMPANY_APP3_URL_TEMPLATE =
  'https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C?$format=json&$filter=Business_Accounting_NO%20eq%20{taxId}&$skip=0&$top=50';

export interface GcisCompanyResponseItem {
  Business_Accounting_NO?: string;
  Company_Name?: string;
  Company_Status?: string;
  Company_Status_Desc?: string;
  Company_Setup_Date?: string;
  Cmp_Business?: Array<{
    Business_Seq_NO?: string;
    Business_Item?: string;
    Business_Item_Desc?: string;
  }>;
}

export interface GcisFetchResult {
  companyStatus: string;
  businessItems: BusinessItem[];
  mode: 'direct' | 'worker';
}

export function parseGcisPayload(data: unknown): {
  companyStatus: string;
  businessItems: BusinessItem[];
} {
  if (!Array.isArray(data) || data.length === 0) {
    return { companyStatus: '', businessItems: [] };
  }
  const first = data[0] as GcisCompanyResponseItem;
  const companyStatus = (first.Company_Status_Desc || '').trim();
  const rawItems = Array.isArray(first.Cmp_Business) ? first.Cmp_Business : [];
  const businessItems: BusinessItem[] = rawItems
    .map((item) => ({
      code: (item.Business_Item || '').trim(),
      desc: (item.Business_Item_Desc || '').trim(),
    }))
    .filter((item) => item.code.length > 0);

  return { companyStatus, businessItems };
}

export async function fetchGcisCompanyData(
  taxId: string,
  options?: {
    workerUrl?: string;
    appToken?: string;
    preferWorker?: boolean;
    fetchImpl?: typeof fetch;
  }
): Promise<GcisFetchResult> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const directUrl = GCIS_COMPANY_APP3_URL_TEMPLATE.replace(
    '{taxId}',
    encodeURIComponent(taxId)
  );

  if (!options?.preferWorker) {
    try {
      const resp = await fetchFn(directUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (resp.ok) {
        const json = await resp.json();
        const parsed = parseGcisPayload(json);
        return { ...parsed, mode: 'direct' };
      }
    } catch {
      // 瀏覽器端直接 fetch 可能因 GCIS 未設 Access-Control-Allow-Origin 被 CORS 阻擋，自動退回呼叫 Worker /gcis
    }
  }

  const workerUrl = (options?.workerUrl || '').trim().replace(/\/+$/, '');
  if (!workerUrl) {
    throw new Error(
      '瀏覽器直接連線 GCIS 遭 CORS 阻擋，請先於「設定頁」填入 Worker 網址與 APP_TOKEN 以透過 /gcis 代理查詢'
    );
  }

  const proxyUrl = `${workerUrl}/gcis?taxId=${encodeURIComponent(taxId)}`;
  const resp = await fetchFn(proxyUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(options?.appToken
        ? { Authorization: `Bearer ${options.appToken}` }
        : {}),
    },
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Worker /gcis 查詢失敗 (${resp.status}): ${errText}`);
  }

  const json = await resp.json();
  const parsed = parseGcisPayload(json);
  return { ...parsed, mode: 'worker' };
}

export async function enrichSingleLeadWithGcis(
  lead: Lead,
  database: BizRadarDB = db,
  fetchImpl?: typeof fetch
): Promise<{ updatedLead: Lead; mode: 'direct' | 'worker' }> {
  const settings = await getAppSettings(database);
  const preferWorker = settings.gcisDirectFetchStatus === 'cors_blocked';

  const result = await fetchGcisCompanyData(lead.id, {
    workerUrl: settings.workerUrl,
    appToken: settings.appToken,
    preferWorker,
    fetchImpl,
  });

  if (
    settings.gcisDirectFetchStatus === 'untested' ||
    (settings.gcisDirectFetchStatus === 'ok' && result.mode === 'worker')
  ) {
    await saveAppSettings(
      {
        gcisDirectFetchStatus:
          result.mode === 'direct' ? 'ok' : 'cors_blocked',
      },
      database
    );
  }

  const now = new Date().toISOString();
  let nextStatus = lead.status;
  const statusHistory = [...(lead.statusHistory || [])];
  const reasonsExtra: string[] = [];

  // companyStatus 非「核准設立」→ status='排除'，理由「公司現況非核准設立」
  if (result.companyStatus && result.companyStatus !== '核准設立') {
    nextStatus = '排除';
    statusHistory.push({
      status: '排除',
      at: now,
      note: '公司現況非核准設立',
    });
    reasonsExtra.push('公司現況非核准設立');
  }

  const rescored = applyScoringToLead(
    {
      ...lead,
      businessItems: result.businessItems,
      companyStatus: result.companyStatus || '核准設立',
      enrichedAt: now,
      status: nextStatus,
      statusHistory,
    },
    settings.services,
    settings.weights
  );

  if (reasonsExtra.length > 0) {
    rescored.reasons = Array.from(
      new Set([...reasonsExtra, ...rescored.reasons])
    );
  }

  await database.leads.put(rescored);
  return { updatedLead: rescored, mode: result.mode };
}
