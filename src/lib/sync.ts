import {
  BizRadarDB,
  canContactLead,
  db,
  getAppSettings,
  saveAppSettings,
  updateLeadStatus,
} from '../db/database';
import { Lead, Suppression, SuppressionSource, SurveyRecord } from '../types';
import { applyScoringToLead } from './scoring';

export interface WorkerSyncPayload {
  suppressions: Array<{
    key: string;
    type: 'taxId' | 'email';
    reason: string;
    source: string;
    created_at: string;
  }>;
  survey_responses: Array<{
    id: number;
    tax_id: string;
    needs: string;
    timing: string;
    contact_pref: string;
    company: string;
    contact: string;
    consent: number;
    created_at: string;
  }>;
  email_events: Array<{
    id: number;
    resend_id: string;
    type: string;
    email: string;
    created_at: string;
  }>;
  serverTime?: string;
}

export interface SyncSummary {
  suppressionsSynced: number;
  surveysSynced: number;
  bouncesSynced: number;
  lastSyncAt: string;
}

export async function applySyncPayload(
  payload: WorkerSyncPayload,
  database: BizRadarDB = db
): Promise<SyncSummary> {
  const settings = await getAppSettings(database);
  const allLeads = await database.leads.toArray();
  const leadByTaxId = new Map<string, Lead>(allLeads.map((l) => [l.id, l]));
  const leadsByEmail = new Map<string, Lead[]>();

  for (const l of allLeads) {
    if (l.email && l.email.trim()) {
      const em = l.email.trim().toLowerCase();
      const arr = leadsByEmail.get(em) || [];
      arr.push(l);
      leadsByEmail.set(em, arr);
    }
  }

  let suppressionsSynced = 0;
  let surveysSynced = 0;
  let bouncesSynced = 0;

  // 1. suppressions 併入本地，對應 lead status -> 拒絕
  for (const sup of payload.suppressions || []) {
    const key = (sup.key || '').trim();
    if (!key) continue;
    const normKey = sup.type === 'email' ? key.toLowerCase() : key;
    const record: Suppression = {
      key: normKey,
      type: sup.type === 'email' ? 'email' : 'taxId',
      reason: sup.reason || 'Worker 同步拒收',
      source: (sup.source as SuppressionSource) || 'unsubscribe',
      at: sup.created_at || new Date().toISOString(),
    };
    await database.suppressions.put(record);
    suppressionsSynced++;

    // 若不是因為 bounce 產生（bounce 下面會設為退件），將對應 lead status -> 拒絕
    if (record.source !== 'bounce') {
      const matchedLeads: Lead[] = [];
      if (record.type === 'taxId') {
        const l = leadByTaxId.get(normKey);
        if (l) matchedLeads.push(l);
      } else {
        const list = leadsByEmail.get(normKey) || [];
        matchedLeads.push(...list);
      }

      for (const lead of matchedLeads) {
        if (lead.status !== '拒絕') {
          const updated = await updateLeadStatus(
            lead.id,
            '拒絕',
            `同步拒收名單（${record.reason}）`,
            database
          );
          if (updated) leadByTaxId.set(updated.id, updated);
        }
      }
    }
  }

  // 2. survey_responses 寫入 surveys：選「不需要聯繫」-> 拒絕；勾選任何服務且同意聯繫 -> 有興趣，並把勾選需求寫入 notes
  let newlyAddedSurveys = 0;
  for (const sr of payload.survey_responses || []) {
    const existingSurvey = await database.surveys.get(sr.id);
    let parsedNeeds: string[] = [];
    try {
      const p = JSON.parse(sr.needs || '[]');
      parsedNeeds = Array.isArray(p) ? p.map(String) : [];
    } catch {
      parsedNeeds = sr.needs ? [sr.needs] : [];
    }

    const surveyRec: SurveyRecord = {
      id: sr.id,
      taxId: sr.tax_id,
      needs: parsedNeeds,
      timing: sr.timing || '',
      contactPref: sr.contact_pref || '',
      company: sr.company || '',
      contact: sr.contact || '',
      consent: Boolean(sr.consent),
      at: sr.created_at || new Date().toISOString(),
    };

    await database.surveys.put(surveyRec);
    surveysSynced++;
    if (!existingSurvey) {
      newlyAddedSurveys++;
    }

    const lead = leadByTaxId.get(sr.tax_id);
    if (lead) {
      if (sr.contact_pref === '不需要聯繫') {
        const updated = await updateLeadStatus(
          lead.id,
          '拒絕',
          '問卷回覆：不需要聯繫',
          database
        );
        if (updated) leadByTaxId.set(updated.id, updated);
      } else {
        const activeNeeds = parsedNeeds.filter((n) => n !== '暫無需求');
        if (activeNeeds.length > 0 && Boolean(sr.consent)) {
          const noteAddition = `[問卷回覆 ${sr.created_at.slice(0, 10)}] 需求：${activeNeeds.join('、')}｜時程：${sr.timing || '未填'}｜偏好：${sr.contact_pref || '未填'}${sr.contact ? `｜聯絡：${sr.contact}` : ''}`;
          const nextNotes = lead.notes
            ? lead.notes.includes(noteAddition)
              ? lead.notes
              : `${lead.notes}\n${noteAddition}`
            : noteAddition;

          const merged: Lead = applyScoringToLead(
            {
              ...lead,
              notes: nextNotes,
              demandFound: true,
              status: '有興趣',
              statusHistory: [
                ...(lead.statusHistory || []),
                {
                  status: '有興趣',
                  at: sr.created_at || new Date().toISOString(),
                  note: `問卷回覆勾選需求：${activeNeeds.join('、')}`,
                },
              ],
            },
            settings.services,
            settings.weights
          );
          await database.leads.put(merged);
          leadByTaxId.set(merged.id, merged);
        }
      }
    }
  }

  // 3. email.bounced -> 對應 lead status -> 退件、sends(bounced)
  for (const ev of payload.email_events || []) {
    if (ev.type === 'email.bounced') {
      bouncesSynced++;
      const em = (ev.email || '').trim().toLowerCase();
      const matchedLeads = em ? leadsByEmail.get(em) || [] : [];

      // 若透過 resend_id 能找到 sends 紀錄，也找出對應 leadId
      if (ev.resend_id) {
        const sendRows = await database.sends
          .where('resendId')
          .equals(ev.resend_id)
          .toArray();
        for (const sRow of sendRows) {
          if (sRow.id !== undefined) {
            await database.sends.update(sRow.id, { result: 'bounced' });
          }
          const l = leadByTaxId.get(sRow.leadId);
          if (l && !matchedLeads.some((m) => m.id === l.id)) {
            matchedLeads.push(l);
          }
        }
      }

      for (const lead of matchedLeads) {
        await database.sends.add({
          leadId: lead.id,
          channel: 'email',
          at: ev.created_at || new Date().toISOString(),
          subject: 'Email 退信 (Bounce)',
          result: 'bounced',
          resendId: ev.resend_id,
        });
        if (lead.status !== '退件') {
          const updated = await updateLeadStatus(
            lead.id,
            '退件',
            `Email 退信 (${ev.email})`,
            database
          );
          if (updated) leadByTaxId.set(updated.id, updated);
        }
      }
    }
  }

  const nextSyncAt = payload.serverTime || new Date().toISOString();
  await saveAppSettings(
    {
      lastSyncAt: nextSyncAt,
      newSurveyCount: (settings.newSurveyCount || 0) + newlyAddedSurveys,
    },
    database
  );

  return {
    suppressionsSynced,
    surveysSynced,
    bouncesSynced,
    lastSyncAt: nextSyncAt,
  };
}

export async function syncWithWorker(
  database: BizRadarDB = db,
  fetchImpl: typeof fetch = fetch
): Promise<SyncSummary | null> {
  const settings = await getAppSettings(database);
  const workerUrl = (settings.workerUrl || '').trim().replace(/\/+$/, '');
  if (!workerUrl || !settings.appToken?.trim()) {
    return null;
  }

  const since = settings.lastSyncAt || '';
  const url = `${workerUrl}/sync${
    since ? `?since=${encodeURIComponent(since)}` : ''
  }`;

  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${settings.appToken.trim()}`,
    },
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`同步失敗 (${resp.status}): ${errText}`);
  }

  const payload = (await resp.json()) as WorkerSyncPayload;
  return applySyncPayload(payload, database);
}

export interface SendSingleEmailResult {
  status: 'sent' | 'excluded_409' | 'limit_429' | 'failed';
  resendId?: string;
  remainingToday?: number;
  error?: string;
}

export async function sendSingleApprovedEmail(params: {
  lead: Lead;
  subject: string;
  bodyText: string;
  database?: BizRadarDB;
  fetchImpl?: typeof fetch;
}): Promise<SendSingleEmailResult> {
  const { lead, subject, bodyText, database = db, fetchImpl = fetch } = params;
  const settings = await getAppSettings(database);

  // 本地寄送前檢查：suppressions、contactCount
  const check = await canContactLead(lead, database);
  if (!check.allowed) {
    return { status: 'failed', error: check.reason };
  }
  if (!lead.email || !lead.email.trim()) {
    return { status: 'failed', error: '無 Email 地址' };
  }

  const workerUrl = (settings.workerUrl || '').trim().replace(/\/+$/, '');
  const resp = await fetchImpl(`${workerUrl}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.appToken.trim()}`,
    },
    body: JSON.stringify({
      taxId: lead.id,
      to: lead.email.trim(),
      subject,
      text: bodyText,
    }),
  });

  const now = new Date().toISOString();

  if (resp.status === 409) {
    await updateLeadStatus(
      lead.id,
      '排除',
      'Worker 回傳 409 已在拒收名單，自動標記排除',
      database
    );
    return { status: 'excluded_409', error: '409 已在拒收名單' };
  }

  if (resp.status === 429) {
    return { status: 'limit_429', error: '今日已達上限' };
  }

  if (!resp.ok) {
    const errData = (await resp.json().catch(() => ({}))) as { error?: string };
    const errMsg = errData.error || `HTTP ${resp.status}`;
    await database.sends.add({
      leadId: lead.id,
      channel: 'email',
      at: now,
      subject,
      result: 'failed',
      error: errMsg,
    });
    return { status: 'failed', error: errMsg };
  }

  const data = (await resp.json()) as {
    ok: boolean;
    resendId?: string;
    remainingToday?: number;
  };

  await database.sends.add({
    leadId: lead.id,
    channel: 'email',
    at: now,
    subject,
    result: 'sent',
    resendId: data.resendId || '',
  });

  const current = await database.leads.get(lead.id);
  if (current) {
    const updated = applyScoringToLead(
      {
        ...current,
        status: '已寄Email',
        contactCount: (current.contactCount || 0) + 1,
        lastContactAt: now,
        statusHistory: [
          ...(current.statusHistory || []),
          {
            status: '已寄Email',
            at: now,
            note: `已寄出開發信 (${data.resendId || 'Resend'})`,
          },
        ],
      },
      settings.services,
      settings.weights
    );
    await database.leads.put(updated);
  }

  return {
    status: 'sent',
    resendId: data.resendId,
    remainingToday: data.remainingToday,
  };
}
