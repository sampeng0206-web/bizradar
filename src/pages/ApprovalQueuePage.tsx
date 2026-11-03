import React, { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import QRCode from 'qrcode';
import {
  canContactLead,
  db,
  getAppSettings,
  updateLeadStatus,
} from '../db/database';
import { applyScoringToLead } from '../lib/scoring';
import { sendSingleApprovedEmail } from '../lib/sync';
import {
  checkMissingRequiredSettings,
  renderTemplateText,
} from '../lib/templates';
import { AppSettings, Lead } from '../types';
import { DEFAULT_SETTINGS } from '../lib/services';

interface CustomDraft {
  subject: string;
  emailBody: string;
  letterBody: string;
}

interface SignedQrPair {
  surveyUrl: string;
  unsubscribeUrl: string;
  surveyQrDataUrl: string;
  unsubQrDataUrl: string;
}

export const ApprovalQueuePage: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [paperSentLeads, setPaperSentLeads] = useState<Lead[]>([]);
  const [suppressedSet, setSuppressedSet] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, CustomDraft>>({});
  const [previewLeadId, setPreviewLeadId] = useState<string | null>(null);

  // 發送 Email 進度
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailProgress, setEmailProgress] = useState<{
    done: number;
    total: number;
    message: string;
  } | null>(null);

  // 紙本列印批次狀態
  const [printBatch, setPrintBatch] = useState<Lead[]>([]);
  const [qrMap, setQrMap] = useState<Record<string, SignedQrPair>>({});
  const [printMode, setPrintMode] = useState<'letters' | 'labels'>('letters');
  const [signingPrint, setSigningPrint] = useState(false);

  const loadQueue = async () => {
    const [allLeads, sups, appSet] = await Promise.all([
      db.leads.toArray(),
      db.suppressions.toArray(),
      getAppSettings(db),
    ]);
    const pending = allLeads
      .filter((l) => l.status === '待核准')
      .sort((a, b) => b.score - a.score);
    const paperSent = allLeads
      .filter((l) => l.status === '已寄紙本')
      .sort((a, b) => (b.lastContactAt || '').localeCompare(a.lastContactAt || ''));

    setLeads(pending);
    setPaperSentLeads(paperSent);
    setSuppressedSet(new Set(sups.map((s) => s.key.trim().toLowerCase())));
    setSettings(appSet);

    const nextDrafts: Record<string, CustomDraft> = {};
    for (const l of pending) {
      nextDrafts[l.id] = {
        subject: renderTemplateText(appSet.emailSubjectTemplate, {
          lead: l,
          settings: appSet,
        }),
        emailBody: renderTemplateText(appSet.emailBodyTemplate, {
          lead: l,
          settings: appSet,
        }),
        letterBody: renderTemplateText(appSet.letterBodyTemplate, {
          lead: l,
          settings: appSet,
        }),
      };
    }
    setDrafts(nextDrafts);
    if (pending.length > 0 && !previewLeadId) {
      setPreviewLeadId(pending[0].id);
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  const missingSettings = useMemo(
    () => checkMissingRequiredSettings(settings),
    [settings]
  );

  const isSuppressed = (lead: Lead) => {
    if (suppressedSet.has(lead.id.toLowerCase())) return true;
    if (lead.email && suppressedSet.has(lead.email.trim().toLowerCase())) {
      return true;
    }
    return false;
  };

  const selectedLeads = useMemo(
    () => leads.filter((l) => selectedIds.has(l.id)),
    [leads, selectedIds]
  );

  const eligibleEmailLeads = useMemo(
    () =>
      selectedLeads.filter(
        (l) =>
          Boolean(l.email && l.email.trim()) &&
          !isSuppressed(l) &&
          (l.contactCount || 0) < 2
      ),
    [selectedLeads, suppressedSet]
  );

  const eligiblePrintLeads = useMemo(
    () =>
      selectedLeads.filter(
        (l) => !isSuppressed(l) && (l.contactCount || 0) < 2
      ),
    [selectedLeads, suppressedSet]
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === leads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(leads.map((l) => l.id)));
    }
  };

  // 逐封呼叫 Worker /send，間隔 3 秒，顯示進度
  const handleSendEmails = async () => {
    if (eligibleEmailLeads.length === 0 || missingSettings.length > 0) return;

    setSendingEmail(true);
    setEmailProgress({
      done: 0,
      total: eligibleEmailLeads.length,
      message: '開始逐封寄送 Email（每封間隔 3 秒）...',
    });

    for (let i = 0; i < eligibleEmailLeads.length; i++) {
      const lead = eligibleEmailLeads[i];
      const draft = drafts[lead.id] || {
        subject: renderTemplateText(settings.emailSubjectTemplate, {
          lead,
          settings,
        }),
        emailBody: renderTemplateText(settings.emailBodyTemplate, {
          lead,
          settings,
        }),
      };

      const startMs = Date.now();
      const res = await sendSingleApprovedEmail({
        lead,
        subject: draft.subject,
        bodyText: draft.emailBody,
        database: db,
      });

      if (res.status === 'limit_429') {
        setEmailProgress({
          done: i,
          total: eligibleEmailLeads.length,
          message: '⚠️ 今日已達上限（429），已自動停止寄送。',
        });
        break;
      }

      const statusMsg =
        res.status === 'sent'
          ? `✅ 已寄出：${lead.name}（今日剩餘額度：${res.remainingToday ?? '-'}）`
          : res.status === 'excluded_409'
            ? `🚫 409 已在拒收名單，自動標記排除：${lead.name}`
            : `❌ 發送失敗（${res.error}）：${lead.name}`;

      setEmailProgress({
        done: i + 1,
        total: eligibleEmailLeads.length,
        message: statusMsg,
      });

      if (i < eligibleEmailLeads.length - 1) {
        const elapsed = Date.now() - startMs;
        const waitMs = Math.max(0, 3000 - elapsed);
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }

    setSendingEmail(false);
    await loadQueue();
  };

  // 準備紙本列印批次：先呼叫 /sign 取得簽章連結並產生 QR Code
  const handlePreparePrintBatch = async () => {
    if (eligiblePrintLeads.length === 0 || missingSettings.length > 0) return;
    setSigningPrint(true);
    try {
      const workerUrl = settings.workerUrl.trim().replace(/\/+$/, '');
      const taxIds = eligiblePrintLeads.map((l) => l.id);
      const resp = await fetch(`${workerUrl}/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.appToken.trim()}`,
        },
        body: JSON.stringify({ taxIds }),
      });

      if (!resp.ok) {
        throw new Error(`呼叫 /sign 失敗 (${resp.status})`);
      }

      const signedData = (await resp.json()) as Record<
        string,
        { survey: string; unsubscribe: string }
      >;

      const nextQrMap: Record<string, SignedQrPair> = {};
      for (const lead of eligiblePrintLeads) {
        const pair = signedData[lead.id];
        if (pair) {
          const [surveyQrDataUrl, unsubQrDataUrl] = await Promise.all([
            QRCode.toDataURL(pair.survey, { width: 120, margin: 1 }),
            QRCode.toDataURL(pair.unsubscribe, { width: 120, margin: 1 }),
          ]);
          nextQrMap[lead.id] = {
            surveyUrl: pair.survey,
            unsubscribeUrl: pair.unsubscribe,
            surveyQrDataUrl,
            unsubQrDataUrl,
          };
        }
      }

      setQrMap(nextQrMap);
      setPrintBatch(eligiblePrintLeads);
    } catch (err) {
      alert(
        `取得紙本信簽章連結失敗：${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setSigningPrint(false);
    }
  };

  const handleExportMailingCsv = () => {
    const targetList = printBatch.length > 0 ? printBatch : eligiblePrintLeads;
    if (targetList.length === 0) return;

    const rows = targetList.map((l) => ({
      統編: l.id,
      公司名稱: l.name,
      地址: l.address,
    }));
    const csv = '\uFEFF' + Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bizradar-mailing-list-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleMarkPaperSent = async () => {
    const targetList = printBatch.length > 0 ? printBatch : eligiblePrintLeads;
    if (targetList.length === 0) return;

    const now = new Date().toISOString();
    for (const lead of targetList) {
      const check = await canContactLead(lead, db);
      if (!check.allowed) continue;

      await db.sends.add({
        leadId: lead.id,
        channel: 'letter',
        at: now,
        subject: '紙本開發信',
        result: 'sent',
      });

      const current = await db.leads.get(lead.id);
      if (current) {
        const updated = applyScoringToLead(
          {
            ...current,
            status: '已寄紙本',
            contactCount: (current.contactCount || 0) + 1,
            lastContactAt: now,
            statusHistory: [
              ...(current.statusHistory || []),
              {
                status: '已寄紙本',
                at: now,
                note: '紙本開發信標記已寄出',
              },
            ],
          },
          settings.services,
          settings.weights
        );
        await db.leads.put(updated);
      }
    }

    setPrintBatch([]);
    setSelectedIds(new Set());
    await loadQueue();
  };

  const handleMarkReturned = async (lead: Lead) => {
    const now = new Date().toISOString();
    await db.sends.add({
      leadId: lead.id,
      channel: 'letter',
      at: now,
      subject: '紙本信退件',
      result: 'returned',
    });
    await updateLeadStatus(lead.id, '退件', '紙本信退回', db);
    await loadQueue();
  };

  const previewLead =
    leads.find((l) => l.id === previewLeadId) || leads[0] || null;

  // 將列印批次切分為每頁 24 格 (3欄×8列) 的地址標籤頁
  const labelSheets = useMemo(() => {
    const sheets: Lead[][] = [];
    for (let i = 0; i < printBatch.length; i += 24) {
      sheets.push(printBatch.slice(i, i + 24));
    }
    return sheets;
  }, [printBatch]);

  return (
    <div className="page-container">
      <div className="no-print">
        <div className="page-header">
          <div>
            <h1>人工核准佇列（Email 發送與紙本信列印）</h1>
            <p className="subtitle">
              目前共有 <strong>{leads.length}</strong> 筆「待核准」名單 ｜ 勾選後可預覽並個別修改信件內容
            </p>
          </div>
          <div className="header-actions">
            <button
              className="btn btn-primary"
              disabled={
                sendingEmail ||
                eligibleEmailLeads.length === 0 ||
                missingSettings.length > 0
              }
              onClick={handleSendEmails}
            >
              📧 核准並寄出Email（符合條件 {eligibleEmailLeads.length} 筆）
            </button>
            <button
              className="btn btn-accent"
              disabled={
                signingPrint ||
                eligiblePrintLeads.length === 0 ||
                missingSettings.length > 0
              }
              onClick={handlePreparePrintBatch}
            >
              🖨️ 核准並加入列印批次（符合條件 {eligiblePrintLeads.length} 筆）
            </button>
          </div>
        </div>

        {missingSettings.length > 0 && (
          <div className="card" style={{ borderColor: '#f59e0b', background: '#fffbeb' }}>
            <strong>⚠️ 必要設定缺漏，寄送與列印按鈕已停用：</strong>
            <span>
              請先前往「設定與備份」頁補齊：{missingSettings.join('、')}
            </span>
          </div>
        )}

        {emailProgress && (
          <div className="card">
            <strong>
              Email 發送進度：{emailProgress.done} / {emailProgress.total}
            </strong>
            <p style={{ margin: '6px 0 0' }}>{emailProgress.message}</p>
          </div>
        )}

        {/* 列印批次操作區 */}
        {printBatch.length > 0 && (
          <div className="card" style={{ borderColor: '#0f766e', background: '#f0fdfa' }}>
            <div className="section-title-row">
              <h2>🖨️ 已就緒列印批次（共 {printBatch.length} 家，已取得簽章 QR Code）</h2>
              <div className="header-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setPrintMode('letters');
                    setTimeout(() => window.print(), 100);
                  }}
                >
                  🖨️ 列印 A4 開發信＋第二頁回郵意向單
                </button>
                <button
                  className="btn btn-accent"
                  onClick={() => {
                    setPrintMode('labels');
                    setTimeout(() => window.print(), 100);
                  }}
                >
                  🏷️ 列印 A4 地址標籤頁（3欄×8列）
                </button>
                <button
                  className="btn btn-outline"
                  onClick={handleExportMailingCsv}
                >
                  ⬇️ 匯出郵寄清單 CSV
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleMarkPaperSent}
                >
                  ✅ 標記已寄出（寫入 sends 與已寄紙本）
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 待核准表格與預覽分欄 */}
        <div className="form-row-2" style={{ alignItems: 'flex-start' }}>
          <div className="card">
            <div className="section-title-row">
              <h3>待核准名單（{leads.length} 筆）</h3>
              <button className="btn btn-sm btn-outline" onClick={toggleSelectAll}>
                {selectedIds.size === leads.length ? '取消全選' : '全選全部'}
              </button>
            </div>
            {leads.length === 0 ? (
              <p className="muted">
                目前無 status=待核准 的名單。請於「名單篩選與建議卡」頁將名單移入待核准。
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table interactive-table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>勾選</th>
                      <th>公司名稱 / 統編</th>
                      <th>分數</th>
                      <th>聯絡管道</th>
                      <th>接觸次數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => {
                      const suppressed = isSuppressed(lead);
                      return (
                        <tr
                          key={lead.id}
                          onClick={() => setPreviewLeadId(lead.id)}
                          className={
                            previewLead?.id === lead.id ? 'row-selected' : ''
                          }
                        >
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(lead.id)}
                              disabled={suppressed || (lead.contactCount || 0) >= 2}
                              onChange={() => toggleSelect(lead.id)}
                            />
                          </td>
                          <td>
                            <strong>{lead.name}</strong>
                            <div className="muted-code">{lead.id}</div>
                          </td>
                          <td>
                            <span className="score-pill score-high">
                              {lead.score}
                            </span>
                          </td>
                          <td>
                            {suppressed ? (
                              <span className="text-danger">拒收名單</span>
                            ) : lead.email ? (
                              <span>✉️ {lead.email}</span>
                            ) : (
                              <span>📮 紙本：{lead.city}{lead.district}</span>
                            )}
                          </td>
                          <td>{lead.contactCount || 0} / 2</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 預覽與個別修改區 */}
          <div className="card">
            <h3>套版預覽與個別修改</h3>
            {!previewLead ? (
              <p className="muted">請點選左側名單以預覽並修改套版內容</p>
            ) : (
              <div className="edit-lead-form">
                <p className="muted" style={{ margin: 0 }}>
                  目前預覽：<strong>{previewLead.name}</strong>（{previewLead.id}）
                </p>
                <label>
                  Email 主旨（純文字）
                  <input
                    type="text"
                    value={drafts[previewLead.id]?.subject || ''}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [previewLead.id]: {
                          ...prev[previewLead.id],
                          subject: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  Email 內文（純文字，寄出時 Worker 自動替換問卷與拒收簽章連結）
                  <textarea
                    rows={10}
                    value={drafts[previewLead.id]?.emailBody || ''}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [previewLead.id]: {
                          ...prev[previewLead.id],
                          emailBody: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  紙本信內文（A4 第一頁）
                  <textarea
                    rows={8}
                    value={drafts[previewLead.id]?.letterBody || ''}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [previewLead.id]: {
                          ...prev[previewLead.id],
                          letterBody: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* 已寄紙本名單：可一鍵退件 */}
        {paperSentLeads.length > 0 && (
          <div className="card">
            <h3>📮 已寄紙本名單（可一鍵標記「退件」）</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>統編</th>
                    <th>公司名稱</th>
                    <th>登記地址</th>
                    <th>寄出日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {paperSentLeads.map((lead) => (
                    <tr key={lead.id}>
                      <td>
                        <code>{lead.id}</code>
                      </td>
                      <td>{lead.name}</td>
                      <td>{lead.address}</td>
                      <td>{lead.lastContactAt?.slice(0, 10) || '-'}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleMarkReturned(lead)}
                        >
                          ↩ 一鍵退件
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* @media print 專用輸出區塊 */}
      <div className="print-only-container">
        {printMode === 'letters' &&
          printBatch.map((lead) => {
            const draft = drafts[lead.id];
            const qr = qrMap[lead.id];
            const letterContent =
              draft?.letterBody ||
              renderTemplateText(settings.letterBodyTemplate, {
                lead,
                settings,
              });

            return (
              <React.Fragment key={lead.id}>
                {/* 第一頁：A4 一頁一封信 */}
                <div className="print-a4-page">
                  <div>
                    <div style={{ marginBottom: '16px', fontSize: '11pt' }}>
                      <p style={{ margin: '2px 0' }}>
                        受文地址：{lead.address}
                      </p>
                      <p style={{ margin: '2px 0', fontWeight: 700 }}>
                        受文者：{lead.name} 負責人 收
                      </p>
                    </div>
                    <hr style={{ marginBottom: '18px' }} />
                    <div className="print-letter-body">{letterContent}</div>
                  </div>

                  {/* 底部印問卷 QR Code、拒收 QR Code 與拒收電話 */}
                  <div className="print-qr-footer">
                    <div className="print-qr-box">
                      {qr?.surveyQrDataUrl && (
                        <img
                          src={qr.surveyQrDataUrl}
                          alt="需求問卷 QR Code"
                          width={96}
                          height={96}
                        />
                      )}
                      <div>
                        <strong>📱 線上需求問卷</strong>
                        <p style={{ margin: '4px 0 0', fontSize: '9.5pt' }}>
                          掃描 QR Code 一分鐘勾選需求
                        </p>
                      </div>
                    </div>

                    <div className="print-qr-box">
                      {qr?.unsubQrDataUrl && (
                        <img
                          src={qr.unsubQrDataUrl}
                          alt="拒收 QR Code"
                          width={96}
                          height={96}
                        />
                      )}
                      <div>
                        <strong>🔕 拒收服務資訊</strong>
                        <p style={{ margin: '4px 0 0', fontSize: '9.5pt' }}>
                          掃描拒收或撥打拒收電話：{settings.companyPhone}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 第二頁：回郵意向單（全部勾選框不得預設勾選） */}
                <div className="print-a4-page">
                  <div>
                    <h2 style={{ marginTop: 0 }}>
                      新創資源與營運支援｜紙本回郵意向單
                    </h2>
                    <p style={{ fontSize: '10.5pt' }}>
                      公司統編：{lead.id} ｜ 公司名稱：{lead.name}
                    </p>

                    <div style={{ marginBottom: '14px' }}>
                      <strong>1. 目前最需要的協助（可複選，請打勾）：</strong>
                      <p style={{ margin: '6px 0' }}>
                        □ 找錢（貸款／補助／募資）　□ 公司登記地址／商務空間
                      </p>
                      <p style={{ margin: '6px 0' }}>
                        □ 會計記帳與稅務諮詢（由合格專業人員提供）　□ 一般法律議題諮詢及專業轉介
                      </p>
                      <p style={{ margin: '6px 0' }}>
                        □ App創業陪跑　□ 線上課程製作與上架　□ 品牌／媒體行銷　□ 暫無需求
                      </p>
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <strong>2. 希望何時了解：</strong>
                      <p style={{ margin: '6px 0' }}>
                        □ 近期（1個月內）　□ 1–3個月　□ 先收資料即可
                      </p>
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <strong>3. 偏好回覆方式：</strong>
                      <p style={{ margin: '6px 0' }}>
                        □ Email　□ 電話　□ 不需要聯繫
                      </p>
                    </div>

                    <div style={{ marginBottom: '14px' }}>
                      <strong>4. 聯絡資訊（選填）：</strong>
                      <p style={{ margin: '10px 0' }}>
                        公司名稱：____________________________________________________
                      </p>
                      <p style={{ margin: '10px 0' }}>
                        聯絡人與聯絡方式（電話／Email）：_____________________________
                      </p>
                    </div>

                    <div
                      style={{
                        border: '1px solid #000',
                        padding: '10px 12px',
                        marginBottom: '16px',
                      }}
                    >
                      <strong>
                        □ 5. 同意沃客買就本次詢問與我聯繫（請主動打勾）
                      </strong>
                    </div>
                  </div>

                  <div style={{ fontSize: '9.5pt', borderTop: '1px solid #333', paddingTop: '10px' }}>
                    <p style={{ margin: '3px 0' }}>
                      資料使用目的：僅回覆本次詢問。保存原則：試點結束後一年內刪除。
                    </p>
                    <p style={{ margin: '3px 0' }}>
                      聯絡窗口：{settings.companyName} ｜ 電話：{settings.companyPhone} ｜ 地址：{settings.companyAddress}
                    </p>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

        {/* A4 地址標籤頁（3欄×8列） */}
        {printMode === 'labels' &&
          labelSheets.map((sheet, sheetIdx) => (
            <div key={sheetIdx} className="print-labels-sheet">
              {sheet.map((lead) => (
                <div key={lead.id} className="print-label-cell">
                  <div className="print-zip-boxes" aria-label="郵遞區號留白">
                    <span className="print-zip-box" />
                    <span className="print-zip-box" />
                    <span className="print-zip-box" />
                    <span className="print-zip-box" />
                    <span className="print-zip-box" />
                  </div>
                  <div style={{ marginBottom: '4px' }}>{lead.address}</div>
                  <div style={{ fontWeight: 700 }}>
                    {lead.name} 負責人 收
                  </div>
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
};
