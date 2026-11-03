import React, { useEffect, useState } from 'react';
import Papa from 'papaparse';
import {
  db,
  getAppSettings,
  saveAppSettings,
  updateLeadStatus,
} from '../db/database';
import { applyScoringToLead } from '../lib/scoring';
import { DEFAULT_SETTINGS } from '../lib/services';
import { syncWithWorker } from '../lib/sync';
import {
  AppSettings,
  Customer,
  Lead,
  SendRecord,
  SettingRecord,
  Suppression,
  SurveyRecord,
} from '../types';

export const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saveBanner, setSaveBanner] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncing, setSyncing] = useState(false);

  // 批次匯入拒收與既有客戶
  const [bulkSuppressionText, setBulkSuppressionText] = useState('');
  const [bulkCustomerText, setBulkCustomerText] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const [counts, setCounts] = useState({ suppressions: 0, customers: 0 });

  // JSON 備份還原二次確認狀態
  const [pendingRestoreJson, setPendingRestoreJson] = useState<string | null>(
    null
  );
  const [restoreConfirmStep, setRestoreConfirmStep] = useState<0 | 1 | 2>(0);

  const loadSettings = async () => {
    const [s, supCount, custCount] = await Promise.all([
      getAppSettings(db),
      db.suppressions.count(),
      db.customers.count(),
    ]);
    setSettings(s);
    setCounts({ suppressions: supCount, customers: custCount });
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const saved = await saveAppSettings(settings, db);

    // 重新計分現有名單以反映最新服務開關與權重
    const allLeads = await db.leads.toArray();
    if (allLeads.length > 0) {
      const rescored = allLeads.map((l) =>
        applyScoringToLead(l, saved.services, saved.weights)
      );
      await db.leads.bulkPut(rescored);
    }

    setSettings(saved);
    setSaveBanner('✅ 設定已儲存至本機 IndexedDB，並已重新計算所有名單分數！');
    setTimeout(() => setSaveBanner(''), 4000);
  };

  const handleManualSync = async () => {
    setSyncing(true);
    setSyncMessage('正在與 Worker /sync 同步中...');
    try {
      const res = await syncWithWorker(db);
      if (!res) {
        setSyncMessage('⚠️ 請先填寫並儲存 Worker 網址與 APP_TOKEN');
      } else {
        setSyncMessage(
          `✅ 同步完成！新增/更新拒收 ${res.suppressionsSynced} 筆、問卷 ${res.surveysSynced} 筆、退信 ${res.bouncesSynced} 筆（${res.lastSyncAt.slice(0, 19).replace('T', ' ')}）`
        );
        await loadSettings();
      }
    } catch (err) {
      setSyncMessage(
        `❌ ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleService = (code: string, enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      services: prev.services.map((s) =>
        s.code === code ? { ...s, enabled } : s
      ),
    }));
  };

  const handleServiceChange = (
    code: string,
    field: 'name' | 'shortPitch',
    value: string
  ) => {
    setSettings((prev) => ({
      ...prev,
      services: prev.services.map((s) =>
        s.code === code ? { ...s, [field]: value } : s
      ),
    }));
  };

  // 批次匯入拒收清單（統編或 Email）
  const handleBulkImportSuppressions = async () => {
    const items = bulkSuppressionText
      .split(/[\n,;，；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) return;

    const now = new Date().toISOString();
    const toPut: Suppression[] = [];
    for (const item of items) {
      const isEmail = item.includes('@');
      const key = isEmail ? item.toLowerCase() : item.padStart(8, '0');
      toPut.push({
        key,
        type: isEmail ? 'email' : 'taxId',
        reason: '手動批次匯入拒收',
        source: 'manual',
        at: now,
      });

      if (!isEmail) {
        const lead = await db.leads.get(key);
        if (lead && lead.status !== '排除') {
          await updateLeadStatus(key, '排除', '手動批次匯入拒收名單', db);
        }
      }
    }
    await db.suppressions.bulkPut(toPut);
    setBulkSuppressionText('');
    setBulkMessage(`✅ 已批次匯入 ${toPut.length} 筆拒收名單`);
    await loadSettings();
  };

  // 批次匯入既有客戶（統編）
  const handleBulkImportCustomers = async () => {
    const items = bulkCustomerText
      .split(/[\n,;，；\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{7,8}$/.test(s))
      .map((s) => s.padStart(8, '0'));
    if (items.length === 0) return;

    const now = new Date().toISOString();
    const toPut: Customer[] = items.map((taxId) => ({
      taxId,
      at: now,
    }));
    await db.customers.bulkPut(toPut);

    for (const taxId of items) {
      const lead = await db.leads.get(taxId);
      if (lead && lead.status !== '排除') {
        await updateLeadStatus(taxId, '排除', '既有客戶排除', db);
      }
    }

    setBulkCustomerText('');
    setBulkMessage(`✅ 已批次匯入 ${toPut.length} 筆既有客戶統編並標記排除`);
    await loadSettings();
  };

  // 匯出全部資料 JSON
  const handleExportFullJson = async () => {
    const [leads, suppressions, customers, sends, surveys, settingsRows] =
      await Promise.all([
        db.leads.toArray(),
        db.suppressions.toArray(),
        db.customers.toArray(),
        db.sends.toArray(),
        db.surveys.toArray(),
        db.settings.toArray(),
      ]);

    // 排除敏感 APP_TOKEN 匯出，或保留設定結構但清空 appToken
    const safeSettings = settingsRows.filter((r) => r.key !== 'appToken');

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      leads,
      suppressions,
      customers,
      sends,
      surveys,
      settings: safeSettings,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bizradar-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 匯出名單 CSV
  const handleExportLeadsCsv = async () => {
    const allLeads = await db.leads.toArray();
    const rows = allLeads.map((l) => ({
      統編: l.id,
      名稱: l.name,
      縣市: l.city,
      行政區: l.district,
      地址: l.address,
      負責人: l.representative,
      資本額: l.capital,
      設立日: l.setupDate,
      組織型態: l.orgType,
      總分: l.score,
      推薦服務: l.services.join(','),
      狀態: l.status,
      Email: l.email,
      電話: l.phone,
      官網: l.website,
      備註: l.notes,
      接觸次數: l.contactCount,
    }));
    const csv = '\uFEFF' + Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bizradar-leads-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 讀取備份 JSON 並進入二次確認
  const handleSelectRestoreFile = async (file: File) => {
    const text = await file.text();
    setPendingRestoreJson(text);
    setRestoreConfirmStep(1);
  };

  const handleExecuteRestore = async () => {
    if (!pendingRestoreJson || restoreConfirmStep !== 2) return;
    try {
      const data = JSON.parse(pendingRestoreJson) as {
        leads?: Lead[];
        suppressions?: Suppression[];
        customers?: Customer[];
        sends?: SendRecord[];
        surveys?: SurveyRecord[];
        settings?: SettingRecord[];
      };

      await db.transaction(
        'rw',
        [
          db.leads,
          db.suppressions,
          db.customers,
          db.sends,
          db.surveys,
          db.settings,
        ],
        async () => {
          await Promise.all([
            db.leads.clear(),
            db.suppressions.clear(),
            db.customers.clear(),
            db.sends.clear(),
            db.surveys.clear(),
          ]);

          if (Array.isArray(data.leads)) await db.leads.bulkPut(data.leads);
          if (Array.isArray(data.suppressions))
            await db.suppressions.bulkPut(data.suppressions);
          if (Array.isArray(data.customers))
            await db.customers.bulkPut(data.customers);
          if (Array.isArray(data.sends)) await db.sends.bulkPut(data.sends);
          if (Array.isArray(data.surveys))
            await db.surveys.bulkPut(data.surveys);
          if (Array.isArray(data.settings))
            await db.settings.bulkPut(data.settings);
        }
      );

      setPendingRestoreJson(null);
      setRestoreConfirmStep(0);
      setBulkMessage('✅ 已完成 JSON 備份還原！');
      await loadSettings();
    } catch (err) {
      alert(
        `JSON 還原失敗：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>系統設定、服務字典、範本與資料備份</h1>
          <p className="subtitle">
            所有設定與 APP_TOKEN 僅儲存於本機瀏覽器 IndexedDB，不會寫入任何程式碼檔案
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={syncing}
            onClick={handleManualSync}
          >
            {syncing ? '⏳ 同步中...' : '🔄 立即同步 Worker 資料'}
          </button>
        </div>
      </div>

      {syncMessage && <div className="card">{syncMessage}</div>}
      {saveBanner && (
        <div className="card" style={{ borderColor: '#0f766e', background: '#f0fdfa' }}>
          {saveBanner}
        </div>
      )}

      <form onSubmit={handleSaveSettings}>
        {/* 1. Worker 與公司基本資訊 */}
        <div className="card">
          <h2>1. Worker 連線與公司簽名資訊（寄送與列印必填）</h2>
          <div className="filter-grid">
            <label className="span-2">
              Cloudflare Worker 網址
              <input
                type="text"
                placeholder="https://bizradar-mailer.<subdomain>.workers.dev"
                value={settings.workerUrl}
                onChange={(e) =>
                  setSettings({ ...settings, workerUrl: e.target.value })
                }
              />
            </label>
            <label className="span-2">
              APP_TOKEN（僅存本機 IndexedDB）
              <input
                type="password"
                placeholder="輸入與 Worker 一致之 APP_TOKEN"
                value={settings.appToken}
                onChange={(e) =>
                  setSettings({ ...settings, appToken: e.target.value })
                }
              />
            </label>
            <label>
              公司全名
              <input
                type="text"
                value={settings.companyName}
                onChange={(e) =>
                  setSettings({ ...settings, companyName: e.target.value })
                }
              />
            </label>
            <label>
              公司電話（紙本拒收專線與簽名）
              <input
                type="text"
                value={settings.companyPhone}
                onChange={(e) =>
                  setSettings({ ...settings, companyPhone: e.target.value })
                }
              />
            </label>
            <label>
              公司地址
              <input
                type="text"
                value={settings.companyAddress}
                onChange={(e) =>
                  setSettings({ ...settings, companyAddress: e.target.value })
                }
              />
            </label>
            <label>
              公司官網
              <input
                type="text"
                value={settings.companyWebsite}
                onChange={(e) =>
                  setSettings({ ...settings, companyWebsite: e.target.value })
                }
              />
            </label>
          </div>
        </div>

        {/* 2. 評分權重設定 */}
        <div className="card">
          <h2>2. 評分權重上限（預設總分 100 = 40 + 25 + 20 + 15）</h2>
          <div className="filter-grid">
            <label>
              服務適配上限（預設 40）
              <input
                type="number"
                value={settings.weights.serviceFitMax}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weights: {
                      ...settings.weights,
                      serviceFitMax: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              時間性上限（預設 25）
              <input
                type="number"
                value={settings.weights.timelinessMax}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weights: {
                      ...settings.weights,
                      timelinessMax: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              可接觸上限（預設 20）
              <input
                type="number"
                value={settings.weights.reachabilityMax}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weights: {
                      ...settings.weights,
                      reachabilityMax: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              需求訊號上限（預設 15）
              <input
                type="number"
                value={settings.weights.demandSignalMax}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weights: {
                      ...settings.weights,
                      demandSignalMax: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
        </div>

        {/* 3. 服務字典（可編輯、逐項開關） */}
        <div className="card">
          <h2>3. 服務字典（可編輯、逐項開關；關閉的服務不得推薦）</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 65 }}>啟用</th>
                  <th style={{ width: 65 }}>代碼</th>
                  <th style={{ width: 110 }}>分類</th>
                  <th style={{ width: 280 }}>服務名稱</th>
                  <th>推薦說明（一律「可能」語氣，禁止「符合資格」「保證」）</th>
                </tr>
              </thead>
              <tbody>
                {settings.services.map((svc) => (
                  <tr key={svc.code}>
                    <td>
                      <input
                        type="checkbox"
                        checked={svc.enabled}
                        onChange={(e) =>
                          handleToggleService(svc.code, e.target.checked)
                        }
                      />
                    </td>
                    <td>
                      <strong>{svc.code}</strong>
                    </td>
                    <td>{svc.categoryLabel}</td>
                    <td>
                      <input
                        type="text"
                        value={svc.name}
                        onChange={(e) =>
                          handleServiceChange(svc.code, 'name', e.target.value)
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={svc.shortPitch}
                        onChange={(e) =>
                          handleServiceChange(
                            svc.code,
                            'shortPitch',
                            e.target.value
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. Email 與紙本信範本 */}
        <div className="card">
          <h2>4. 純文字開發信與紙本信範本</h2>
          <p className="muted">
            可用變數：<code>{'{{公司名稱}}'}</code> <code>{'{{負責人}}'}</code>{' '}
            <code>{'{{推薦服務}}'}</code> <code>{'{{問卷連結}}'}</code>{' '}
            <code>{'{{拒收連結}}'}</code> <code>{'{{公司全名}}'}</code>{' '}
            <code>{'{{地址}}'}</code> <code>{'{{電話}}'}</code>{' '}
            <code>{'{{官網}}'}</code>
          </p>
          <div className="edit-lead-form">
            <label>
              Email 主旨預設
              <input
                type="text"
                value={settings.emailSubjectTemplate}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    emailSubjectTemplate: e.target.value,
                  })
                }
              />
            </label>
            <div className="form-row-2">
              <label>
                Email 內文範本（純文字）
                <textarea
                  rows={12}
                  value={settings.emailBodyTemplate}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      emailBodyTemplate: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                紙本信內文範本
                <textarea
                  rows={12}
                  value={settings.letterBodyTemplate}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      letterBodyTemplate: e.target.value,
                    })
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div className="form-actions" style={{ marginBottom: 24 }}>
          <button type="submit" className="btn btn-primary">
            💾 儲存所有設定並重新計算分數
          </button>
        </div>
      </form>

      {/* 5. 備份與批次排除匯入 */}
      <div className="card">
        <h2>5. 資料備份、還原與批次匯入排除名單</h2>
        {bulkMessage && (
          <p style={{ color: '#0f766e', fontWeight: 700 }}>{bulkMessage}</p>
        )}

        <div className="header-actions" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExportFullJson}
          >
            📦 匯出全部資料 JSON 備份
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={handleExportLeadsCsv}
          >
            📊 匯出名單 CSV
          </button>
          <label className="btn btn-outline">
            📂 匯入 JSON 備份還原（覆蓋前二次確認）
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  handleSelectRestoreFile(e.target.files[0]);
                }
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {/* 二次確認對話框 */}
        {restoreConfirmStep === 1 && (
          <div className="lost-reason-box">
            <strong>
              ⚠️ 【第一次確認】確定要以備份 JSON 覆蓋本機所有 IndexedDB 資料嗎？目前本機名單將被清除並替換。
            </strong>
            <div className="form-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setRestoreConfirmStep(2)}
              >
                是，進入第二次確認
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setPendingRestoreJson(null);
                  setRestoreConfirmStep(0);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {restoreConfirmStep === 2 && (
          <div className="lost-reason-box">
            <strong>
              🚨 【第二次最終確認】此動作不可復原！請再次點擊下方按鈕以執行覆蓋還原：
            </strong>
            <div className="form-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleExecuteRestore}
              >
                確認覆蓋並還原全部資料
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setPendingRestoreJson(null);
                  setRestoreConfirmStep(0);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="form-row-2" style={{ marginTop: 14 }}>
          <div>
            <label>
              拒收清單批次匯入（目前累計 {counts.suppressions} 筆；可貼上多筆統編或 Email，以換行或逗號分隔）
              <textarea
                rows={4}
                value={bulkSuppressionText}
                onChange={(e) => setBulkSuppressionText(e.target.value)}
                placeholder="例如：&#10;12345678&#10;no-spam@example.com"
              />
            </label>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ marginTop: 6 }}
              onClick={handleBulkImportSuppressions}
            >
              ➕ 批次加入拒收名單
            </button>
          </div>

          <div>
            <label>
              既有客戶統編批次匯入（目前累計 {counts.customers} 筆；可貼上多筆 8 碼統編，自動標記排除）
              <textarea
                rows={4}
                value={bulkCustomerText}
                onChange={(e) => setBulkCustomerText(e.target.value)}
                placeholder="例如：&#10;20828393&#10;87654321"
              />
            </label>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ marginTop: 6 }}
              onClick={handleBulkImportCustomers}
            >
              ➕ 批次加入既有客戶排除名單
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
