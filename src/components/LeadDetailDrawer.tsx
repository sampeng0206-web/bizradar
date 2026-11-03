import React, { useEffect, useState } from 'react';
import {
  db,
  updateLeadEditableFields,
  updateLeadStatus,
} from '../db/database';
import { getServiceMap } from '../lib/services';
import { Lead, LeadStatus, ServiceDefinition } from '../types';

const ALL_STATUSES: LeadStatus[] = [
  '新線索',
  '待查核',
  '待核准',
  '已寄Email',
  '已寄紙本',
  '有興趣',
  '未回覆',
  '拒絕',
  '退件',
  '洽談中',
  '已報價',
  '成交',
  '未成交',
  '排除',
];

const QUICK_REPLY_STATUSES: LeadStatus[] = [
  '有興趣',
  '未回覆',
  '拒絕',
  '洽談中',
  '已報價',
  '成交',
  '未成交',
];

interface LeadDetailDrawerProps {
  lead: Lead | null;
  services: ServiceDefinition[];
  onClose: () => void;
  onUpdated: (updated: Lead) => void;
}

export const LeadDetailDrawer: React.FC<LeadDetailDrawerProps> = ({
  lead,
  services,
  onClose,
  onUpdated,
}) => {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [demandFound, setDemandFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [lostReasonModal, setLostReasonModal] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [statusNote, setStatusNote] = useState('');

  useEffect(() => {
    if (lead) {
      setEmail(lead.email || '');
      setPhone(lead.phone || '');
      setWebsite(lead.website || '');
      setNotes(lead.notes || '');
      setDemandFound(Boolean(lead.demandFound));
      setSaveMessage('');
      setLostReasonModal(false);
      setLostReason('');
      setStatusNote('');
    }
  }, [lead]);

  if (!lead) return null;

  const serviceMap = getServiceMap(services);
  const datasetUrl =
    lead.source === 'company'
      ? 'https://data.gov.tw/dataset/6047'
      : 'https://data.gov.tw/dataset/6668';
  const datasetLabel =
    lead.source === 'company'
      ? '公司設立登記清冊 (dataset/6047)'
      : '商業設立登記清冊 (dataset/6668)';

  const handleSaveFields = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await updateLeadEditableFields(lead.id, {
        email,
        phone,
        website,
        notes,
        demandFound,
      });
      if (updated) {
        onUpdated(updated);
        setSaveMessage(`已儲存並重新計分（目前總分：${updated.score} 分）`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (
    targetStatus: LeadStatus,
    customNote?: string
  ) => {
    if (targetStatus === '未成交' && !customNote?.trim()) {
      setLostReasonModal(true);
      return;
    }

    const updated = await updateLeadStatus(
      lead.id,
      targetStatus,
      customNote?.trim() || statusNote.trim() || undefined
    );
    if (updated) {
      // 若為成交，同步加入 customers 排除表
      if (targetStatus === '成交') {
        await db.customers.put({
          taxId: lead.id,
          name: lead.name,
          at: new Date().toISOString(),
        });
      }
      setStatusNote('');
      setLostReasonModal(false);
      setLostReason('');
      onUpdated(updated);
    }
  };

  const handleMarkPaperReturned = async () => {
    const now = new Date().toISOString();
    await db.sends.add({
      leadId: lead.id,
      channel: 'letter',
      at: now,
      subject: '紙本開發信退件',
      result: 'returned',
    });
    const updated = await updateLeadStatus(lead.id, '退件', '紙本信退件');
    if (updated) onUpdated(updated);
  };

  const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `${lead.name} ${lead.id}`
  )}`;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer-panel"
        onClick={(e) => e.stopPropagation()}
        aria-label="商機建議卡"
      >
        <div className="drawer-header">
          <div>
            <div className="drawer-badges">
              <span className="badge badge-score">總分 {lead.score} 分</span>
              <span className="badge badge-status">{lead.status}</span>
              <span className="badge badge-org">{lead.orgType}</span>
            </div>
            <h2 className="drawer-title">{lead.name}</h2>
            <p className="drawer-subtitle">
              統編：{lead.id} ｜ 負責人：{lead.representative || '未載明'} ｜ 資本額：
              {(lead.capital / 10000).toLocaleString()} 萬 ｜ 設立日：{lead.setupDate}
            </p>
            <p className="drawer-subtitle">登記地址：{lead.address}</p>
          </div>
          <button className="btn btn-secondary" onClick={onClose}>
            關閉 ✕
          </button>
        </div>

        <div className="drawer-actions-bar">
          <a
            href={googleSearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            🔍 Google搜尋官網
          </a>
          {lead.status !== '待核准' &&
            lead.status !== '排除' &&
            lead.status !== '拒絕' && (
              <button
                className="btn btn-accent"
                onClick={() => handleStatusChange('待核准', '人工移入待核准佇列')}
              >
                ✓ 移入待核准佇列
              </button>
            )}
          {lead.status === '已寄紙本' && (
            <button
              className="btn btn-danger"
              onClick={handleMarkPaperReturned}
            >
              ↩ 一鍵標記紙本退件
            </button>
          )}
        </div>

        {/* 分數拆解 */}
        <div className="score-breakdown-bar">
          <span>
            服務適配：<strong>{lead.scoreBreakdown.serviceFit}</strong>/40
          </span>
          <span>
            時間性：<strong>{lead.scoreBreakdown.timeliness}</strong>/25
          </span>
          <span>
            可接觸：<strong>{lead.scoreBreakdown.reachability}</strong>/20
          </span>
          <span>
            需求訊號：<strong>{lead.scoreBreakdown.demandSignal}</strong>/15
          </span>
        </div>

        {/* 商機建議卡六欄 */}
        <div className="advice-grid">
          <div className="advice-card">
            <h3>1. 推薦服務</h3>
            {lead.services.length === 0 ? (
              <p className="muted">尚無啟用之推薦服務</p>
            ) : (
              <ul className="compact-list">
                {lead.services.map((code) => {
                  const def = serviceMap.get(code);
                  return (
                    <li key={code}>
                      <strong>{code}</strong>：{def ? def.name : code}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="advice-card">
            <h3>2. 推薦理由</h3>
            <ul className="compact-list">
              {lead.reasons.map((r, idx) => (
                <li key={idx}>{r}</li>
              ))}
            </ul>
          </div>

          <div className="advice-card">
            <h3>3. 來源</h3>
            <p>
              <strong>匯入檔案：</strong>
              {lead.sourceFile}
            </p>
            <p>
              <strong>匯入時間：</strong>
              {lead.importedAt ? lead.importedAt.slice(0, 19).replace('T', ' ') : '-'}
            </p>
            <p>
              <strong>官方資料集：</strong>
              <a href={datasetUrl} target="_blank" rel="noopener noreferrer">
                {datasetLabel}
              </a>
            </p>
          </div>

          <div className="advice-card">
            <h3>4. 未知條件</h3>
            <ul className="compact-list">
              {lead.unknowns.map((u, idx) => (
                <li key={idx}>{u}</li>
              ))}
            </ul>
          </div>

          <div className="advice-card">
            <h3>5. 聯絡建議</h3>
            <p className="highlight-text">{lead.contactAdvice}</p>
            <p className="muted">
              已接觸次數：{lead.contactCount || 0} / 2 次
              {lead.lastContactAt
                ? `（最近：${lead.lastContactAt.slice(0, 10)}）`
                : ''}
            </p>
          </div>

          <div className="advice-card">
            <h3>6. 下一步</h3>
            <p>{lead.nextStep}</p>
          </div>
        </div>

        {/* 營業項目清單與 enrichedAt */}
        <section className="drawer-section">
          <div className="section-title-row">
            <h3>營業項目清單（經濟部商工資料）</h3>
            <span className="muted">
              {lead.enrichedAt
                ? `補抓時間：${lead.enrichedAt.slice(0, 19).replace('T', ' ')}（現況：${lead.companyStatus || '核准設立'}）`
                : '尚未補抓營業項目'}
            </span>
          </div>
          {lead.businessItems && lead.businessItems.length > 0 ? (
            <div className="business-items-tags">
              {lead.businessItems.map((item, idx) => (
                <span key={`${item.code}-${idx}`} className="biz-tag">
                  <code>{item.code}</code> {item.desc}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">
              目前無營業項目明細（若為公司組織，可於名單頁點選「補抓營業項目」取得）
            </p>
          )}
        </section>

        {/* 可編輯聯絡與需求欄位 */}
        <section className="drawer-section">
          <h3>人工查核與聯絡資料編輯（存檔即重算分數）</h3>
          <form onSubmit={handleSaveFields} className="edit-lead-form">
            <div className="form-row-2">
              <label>
                公開商務 Email（+12分）
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="例如：contact@example.com.tw"
                />
              </label>
              <label>
                聯絡電話
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="例如：02-2345-6789"
                />
              </label>
            </div>
            <label>
              官方網站／公開粉絲頁網址（+8分）
              <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..."
              />
            </label>
            <label>
              查核備註／需求筆記（+4分）
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="記錄公開徵才、產品上市、補助或貸款相關可能需求訊號..."
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={demandFound}
                onChange={(e) => setDemandFound(e.target.checked)}
              />
              <span>已發現明確需求訊號（demandFound，需求訊號直接滿分 +15）</span>
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? '儲存中...' : '💾 儲存並重算分數'}
              </button>
              {saveMessage && <span className="save-msg">{saveMessage}</span>}
            </div>
          </form>
        </section>

        {/* 回覆處理與狀態流 */}
        <section className="drawer-section">
          <h3>回覆處理與狀態變更</h3>
          <div className="quick-reply-buttons">
            {QUICK_REPLY_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                className={`btn btn-sm ${
                  lead.status === st ? 'btn-primary' : 'btn-outline'
                }`}
                onClick={() => handleStatusChange(st)}
              >
                {st}
              </button>
            ))}
          </div>

          {lostReasonModal && (
            <div className="lost-reason-box">
              <label>
                <strong>請填寫「未成交」原因（必填）：</strong>
                <input
                  type="text"
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                  placeholder="例如：預算考量、已有配合會計師、暫緩創業計畫..."
                />
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={!lostReason.trim()}
                  onClick={() => handleStatusChange('未成交', lostReason)}
                >
                  確認標記未成交
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setLostReasonModal(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="manual-status-row">
            <select
              value={lead.status}
              onChange={(e) => handleStatusChange(e.target.value as LeadStatus)}
              aria-label="切換完整狀態流"
            >
              {ALL_STATUSES.map((st) => (
                <option key={st} value={st}>
                  狀態：{st}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="狀態變更備註（選填）"
            />
          </div>

          {/* 狀態歷程 */}
          <div className="status-history">
            <h4>狀態紀錄（statusHistory）</h4>
            <ul className="compact-list">
              {(lead.statusHistory || [])
                .slice()
                .reverse()
                .map((h, i) => (
                  <li key={i}>
                    <code>{h.at.slice(0, 16).replace('T', ' ')}</code> —{' '}
                    <strong>{h.status}</strong>
                    {h.note ? `（${h.note}）` : ''}
                  </li>
                ))}
            </ul>
          </div>
        </section>
      </aside>
    </div>
  );
};
