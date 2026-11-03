import Dexie, { type Table } from 'dexie';
import {
  AppSettings,
  Customer,
  Lead,
  LeadStatus,
  SendRecord,
  SettingRecord,
  Suppression,
  SurveyRecord,
} from '../types';
import { applyScoringToLead } from '../lib/scoring';
import { DEFAULT_SETTINGS } from '../lib/services';

export class BizRadarDB extends Dexie {
  leads!: Table<Lead, string>;
  suppressions!: Table<Suppression, string>;
  customers!: Table<Customer, string>;
  sends!: Table<SendRecord, number>;
  surveys!: Table<SurveyRecord, number>;
  settings!: Table<SettingRecord, string>;

  constructor(dbName = 'BizRadarDB') {
    super(dbName);
    this.version(1).stores({
      leads: 'id, setupDate, city, score, status',
      suppressions: 'key, type, source, at',
      customers: 'taxId',
      sends: '++id, leadId, channel, at, result, resendId',
      surveys: 'id, taxId, at',
      settings: 'key',
    });
  }
}

export const db = new BizRadarDB();

export async function initPersistentStorage(): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persist === 'function'
    ) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore storage persist error in unsupported environments
  }
  return false;
}

export async function getAppSettings(
  database: BizRadarDB = db
): Promise<AppSettings> {
  const rows = await database.settings.toArray();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    workerUrl: (map.get('workerUrl') as string) ?? DEFAULT_SETTINGS.workerUrl,
    appToken: (map.get('appToken') as string) ?? DEFAULT_SETTINGS.appToken,
    companyName:
      (map.get('companyName') as string) ?? DEFAULT_SETTINGS.companyName,
    companyAddress:
      (map.get('companyAddress') as string) ?? DEFAULT_SETTINGS.companyAddress,
    companyPhone:
      (map.get('companyPhone') as string) ?? DEFAULT_SETTINGS.companyPhone,
    companyWebsite:
      (map.get('companyWebsite') as string) ?? DEFAULT_SETTINGS.companyWebsite,
    emailSubjectTemplate:
      (map.get('emailSubjectTemplate') as string) ??
      DEFAULT_SETTINGS.emailSubjectTemplate,
    emailBodyTemplate:
      (map.get('emailBodyTemplate') as string) ??
      DEFAULT_SETTINGS.emailBodyTemplate,
    letterBodyTemplate:
      (map.get('letterBodyTemplate') as string) ??
      DEFAULT_SETTINGS.letterBodyTemplate,
    services:
      (map.get('services') as AppSettings['services']) ??
      DEFAULT_SETTINGS.services,
    weights:
      (map.get('weights') as AppSettings['weights']) ??
      DEFAULT_SETTINGS.weights,
    lastSyncAt:
      (map.get('lastSyncAt') as string) ?? DEFAULT_SETTINGS.lastSyncAt,
    newSurveyCount:
      (map.get('newSurveyCount') as number) ?? DEFAULT_SETTINGS.newSurveyCount,
    gcisDirectFetchStatus:
      (map.get('gcisDirectFetchStatus') as AppSettings['gcisDirectFetchStatus']) ??
      DEFAULT_SETTINGS.gcisDirectFetchStatus,
  };
}

export async function saveAppSettings(
  partial: Partial<AppSettings>,
  database: BizRadarDB = db
): Promise<AppSettings> {
  const entries: SettingRecord[] = Object.entries(partial).map(
    ([key, value]) => ({
      key,
      value,
    })
  );
  await database.settings.bulkPut(entries);
  return getAppSettings(database);
}

export interface UpsertBatchSummary {
  added: number;
  updated: number;
  excluded: number;
}

export async function upsertImportedLeads(
  leadsMap: Map<string, Lead>,
  database: BizRadarDB = db
): Promise<UpsertBatchSummary> {
  const settings = await getAppSettings(database);
  const [suppressions, customers] = await Promise.all([
    database.suppressions.toArray(),
    database.customers.toArray(),
  ]);

  const suppressedSet = new Set(
    suppressions.map((s) => s.key.trim().toLowerCase())
  );
  const customerSet = new Set(customers.map((c) => c.taxId.trim()));

  const ids = Array.from(leadsMap.keys());
  const existingLeads = await database.leads.bulkGet(ids);
  const existingMap = new Map<string, Lead>();
  existingLeads.forEach((l) => {
    if (l) existingMap.set(l.id, l);
  });

  let added = 0;
  let updated = 0;
  let excluded = 0;
  const toSave: Lead[] = [];

  for (const [taxId, incoming] of leadsMap.entries()) {
    const existing = existingMap.get(taxId);
    const emailLower = (existing?.email || incoming.email || '')
      .trim()
      .toLowerCase();
    const isSuppressedOrCustomer =
      suppressedSet.has(taxId.toLowerCase()) ||
      (emailLower !== '' && suppressedSet.has(emailLower)) ||
      customerSet.has(taxId);

    if (existing) {
      // 統編已存在只更新基本欄位，保留 status、email、notes、紀錄
      let nextStatus: LeadStatus = existing.status;
      const history = [...(existing.statusHistory || [])];

      if (isSuppressedOrCustomer && existing.status !== '排除') {
        nextStatus = '排除';
        history.push({
          status: '排除',
          at: incoming.importedAt,
          note: '匯入更新時命中拒收或既有客戶名單，自動排除',
        });
      }

      const merged: Lead = {
        ...existing,
        name: incoming.name,
        address: incoming.address,
        city: incoming.city,
        district: incoming.district,
        representative: incoming.representative,
        capital: incoming.capital,
        setupDate: incoming.setupDate,
        source: incoming.source,
        sourceFile: incoming.sourceFile,
        importedAt: incoming.importedAt,
        orgType: incoming.orgType,
        status: nextStatus,
        statusHistory: history,
      };

      const rescored = applyScoringToLead(
        merged,
        settings.services,
        settings.weights
      );
      toSave.push(rescored);
      updated++;
      if (rescored.status === '排除') excluded++;
    } else {
      let nextStatus: LeadStatus = incoming.status;
      const history = [...(incoming.statusHistory || [])];
      if (isSuppressedOrCustomer && nextStatus !== '排除') {
        nextStatus = '排除';
        history.push({
          status: '排除',
          at: incoming.importedAt,
          note: '匯入時命中拒收或既有客戶名單，自動排除',
        });
      }

      const rescored = applyScoringToLead(
        {
          ...incoming,
          status: nextStatus,
          statusHistory: history,
        },
        settings.services,
        settings.weights
      );
      toSave.push(rescored);
      added++;
      if (rescored.status === '排除') excluded++;
    }
  }

  await database.leads.bulkPut(toSave);
  return { added, updated, excluded };
}

export async function updateLeadStatus(
  leadId: string,
  newStatus: LeadStatus,
  note?: string,
  database: BizRadarDB = db
): Promise<Lead | undefined> {
  const lead = await database.leads.get(leadId);
  if (!lead) return undefined;

  const settings = await getAppSettings(database);
  const now = new Date().toISOString();

  const updatedLead: Lead = applyScoringToLead(
    {
      ...lead,
      status: newStatus,
      statusHistory: [
        ...(lead.statusHistory || []),
        {
          status: newStatus,
          at: now,
          note,
        },
      ],
    },
    settings.services,
    settings.weights
  );

  await database.leads.put(updatedLead);

  // 改為「拒絕」時自動把統編與 email 加入 suppressions
  if (newStatus === '拒絕') {
    const suppressionsToAdd: Suppression[] = [
      {
        key: lead.id,
        type: 'taxId',
        reason: note || '人工標記拒絕',
        source: 'status',
        at: now,
      },
    ];
    if (lead.email && lead.email.trim()) {
      suppressionsToAdd.push({
        key: lead.email.trim().toLowerCase(),
        type: 'email',
        reason: note || '人工標記拒絕',
        source: 'status',
        at: now,
      });
    }
    await database.suppressions.bulkPut(suppressionsToAdd);
  }

  return updatedLead;
}

export async function updateLeadEditableFields(
  leadId: string,
  fields: {
    email?: string;
    phone?: string;
    website?: string;
    notes?: string;
    demandFound?: boolean;
  },
  database: BizRadarDB = db
): Promise<Lead | undefined> {
  const lead = await database.leads.get(leadId);
  if (!lead) return undefined;

  const settings = await getAppSettings(database);
  const merged: Lead = {
    ...lead,
    email: fields.email !== undefined ? fields.email.trim() : lead.email,
    phone: fields.phone !== undefined ? fields.phone.trim() : lead.phone,
    website: fields.website !== undefined ? fields.website.trim() : lead.website,
    notes: fields.notes !== undefined ? fields.notes : lead.notes,
    demandFound:
      fields.demandFound !== undefined ? fields.demandFound : lead.demandFound,
  };

  // 若新填入之 email 在 suppressions 內，標為排除
  if (merged.email) {
    const sup = await database.suppressions.get(merged.email.toLowerCase());
    if (sup && merged.status !== '排除' && merged.status !== '拒絕') {
      merged.status = '排除';
      merged.statusHistory = [
        ...(merged.statusHistory || []),
        {
          status: '排除',
          at: new Date().toISOString(),
          note: '填入之 Email 位於拒收名單，自動排除',
        },
      ];
    }
  }

  const rescored = applyScoringToLead(
    merged,
    settings.services,
    settings.weights
  );
  await database.leads.put(rescored);
  return rescored;
}

/**
 * 寄送前本地檢查：suppressions、contactCount（同一家最多1封開發信＋1次跟進 = 上限2次）
 */
export async function canContactLead(
  lead: Lead,
  database: BizRadarDB = db
): Promise<{ allowed: boolean; reason?: string }> {
  if (lead.status === '排除' || lead.status === '拒絕') {
    return { allowed: false, reason: `狀態為「${lead.status}」，不可寄送` };
  }
  if ((lead.contactCount || 0) >= 2) {
    return {
      allowed: false,
      reason: '已達接觸次數上限（最多 1 封開發信＋1 次跟進，共 2 次）',
    };
  }
  const taxSup = await database.suppressions.get(lead.id);
  if (taxSup) {
    return { allowed: false, reason: `統編 ${lead.id} 在拒收名單中` };
  }
  if (lead.email && lead.email.trim()) {
    const emailSup = await database.suppressions.get(
      lead.email.trim().toLowerCase()
    );
    if (emailSup) {
      return { allowed: false, reason: `Email ${lead.email} 在拒收名單中` };
    }
  }
  const customer = await database.customers.get(lead.id);
  if (customer) {
    return { allowed: false, reason: `統編 ${lead.id} 為既有客戶` };
  }
  return { allowed: true };
}
