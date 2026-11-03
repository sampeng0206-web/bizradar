import React, { useState } from 'react';
import Papa from 'papaparse';
import { db, upsertImportedLeads } from '../db/database';
import {
  autoMapHeaders,
  CsvErrorRow,
  decodeCsvBuffer,
  HeaderMapping,
  parseCsvTextWithMapping,
} from '../lib/csvParser';
import { Lead } from '../types';

interface PendingFile {
  fileName: string;
  csvText: string;
  encoding: 'utf-8' | 'big5';
  headers: string[];
  mapping: HeaderMapping;
  missingRequired: ('taxId' | 'name' | 'address' | 'setupDate')[];
}

interface ImportReport {
  filesProcessed: string[];
  totalRead: number;
  added: number;
  updated: number;
  excluded: number;
  errorCount: number;
  errors: CsvErrorRow[];
}

export const ImportPage: React.FC = () => {
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [pendingManualFiles, setPendingManualFiles] = useState<PendingFile[]>(
    []
  );
  const [readyAutoFiles, setReadyAutoFiles] = useState<PendingFile[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);

  const inspectFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) =>
      f.name.toLowerCase().endsWith('.csv')
    );
    if (files.length === 0) return;

    setProcessing(true);
    setReport(null);

    const autoFiles: PendingFile[] = [];
    const manualFiles: PendingFile[] = [];

    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const { text, encoding } = decodeCsvBuffer(buffer);
      const preview = Papa.parse<Record<string, string>>(text, {
        header: true,
        preview: 1,
        skipEmptyLines: true,
      });
      const headers = preview.meta.fields || [];
      const { mapping, missingRequired } = autoMapHeaders(headers);

      const item: PendingFile = {
        fileName: file.name,
        csvText: text,
        encoding,
        headers,
        mapping,
        missingRequired,
      };

      if (missingRequired.length > 0) {
        manualFiles.push(item);
      } else {
        autoFiles.push(item);
      }
    }

    if (manualFiles.length > 0) {
      setReadyAutoFiles(autoFiles);
      setPendingManualFiles(manualFiles);
      setProcessing(false);
    } else {
      await executeBatchImport(autoFiles);
    }
  };

  const executeBatchImport = async (filesToImport: PendingFile[]) => {
    setProcessing(true);
    try {
      const [suppressions, customers] = await Promise.all([
        db.suppressions.toArray(),
        db.customers.toArray(),
      ]);
      const suppressedKeys = new Set(
        suppressions.map((s) => s.key.trim().toLowerCase())
      );
      const customerTaxIds = new Set(customers.map((c) => c.taxId.trim()));
      const now = new Date().toISOString();

      let totalRead = 0;
      const combinedLeadsMap = new Map<string, Lead>();
      const allErrors: CsvErrorRow[] = [];

      for (const pf of filesToImport) {
        const res = parseCsvTextWithMapping({
          csvText: pf.csvText,
          fileName: pf.fileName,
          mapping: pf.mapping,
          importedAt: now,
          suppressedKeys,
          customerTaxIds,
        });
        totalRead += res.totalRead;
        allErrors.push(...res.errors);
        // 同批重複只留一筆
        for (const [taxId, lead] of res.leadsMap.entries()) {
          if (!combinedLeadsMap.has(taxId)) {
            combinedLeadsMap.set(taxId, lead);
          }
        }
      }

      const upsertRes = await upsertImportedLeads(combinedLeadsMap, db);

      setReport({
        filesProcessed: filesToImport.map(
          (f) => `${f.fileName} (${f.encoding.toUpperCase()})`
        ),
        totalRead,
        added: upsertRes.added,
        updated: upsertRes.updated,
        excluded: upsertRes.excluded,
        errorCount: allErrors.length,
        errors: allErrors,
      });
      setPendingManualFiles([]);
      setReadyAutoFiles([]);
    } finally {
      setProcessing(false);
    }
  };

  const handleManualMappingChange = (
    fileIdx: number,
    field: keyof HeaderMapping,
    value: string
  ) => {
    setPendingManualFiles((prev) =>
      prev.map((item, idx) => {
        if (idx !== fileIdx) return item;
        const nextMapping: HeaderMapping = {
          ...item.mapping,
          [field]: value || undefined,
        };
        const req: ('taxId' | 'name' | 'address' | 'setupDate')[] = [
          'taxId',
          'name',
          'address',
          'setupDate',
        ];
        const missingRequired = req.filter((k) => !nextMapping[k]);
        return {
          ...item,
          mapping: nextMapping,
          missingRequired,
        };
      })
    );
  };

  const handleConfirmManualImport = async () => {
    await executeBatchImport([...readyAutoFiles, ...pendingManualFiles]);
  };

  const handleDownloadErrorsCsv = () => {
    if (!report || report.errors.length === 0) return;
    const csvRows = report.errors.map((e) => ({
      檔案名稱: e.fileName,
      列號: e.rowNumber,
      統編: e.taxId,
      名稱: e.name,
      錯誤或異常原因: e.reason,
      原始資料JSON: JSON.stringify(e.rawRow),
    }));
    const csvContent = '\uFEFF' + Papa.unparse(csvRows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bizradar-import-errors-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>匯入經濟部新設企業清冊</h1>
          <p className="subtitle">
            每月14日更新，下載最近2–3個月CSV拖進來（支援多檔拖放、自動偵測 UTF-8 / Big5 編碼與去重更新）
          </p>
        </div>
        <div className="official-links">
          <a
            href="https://data.gov.tw/dataset/6047"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            📥 公司設立登記清冊 (dataset/6047)
          </a>
          <a
            href="https://data.gov.tw/dataset/6668"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-accent"
          >
            📥 商業設立登記清冊 (dataset/6668)
          </a>
        </div>
      </div>

      {/* 拖放區 */}
      <div
        className={`dropzone ${isDragging ? 'dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files) {
            inspectFiles(e.dataTransfer.files);
          }
        }}
      >
        <p className="dropzone-title">
          {processing
            ? '⏳ 正在解析與寫入本機 IndexedDB...'
            : '將一或多個官方 CSV 檔案拖放至此，或點擊選擇檔案'}
        </p>
        <p className="muted">
          所有公司名單僅儲存於您的瀏覽器本機 IndexedDB，絕不上傳伺服器或寫入 Git。
        </p>
        <label className="btn btn-outline">
          選擇 CSV 檔案（可多選）
          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) inspectFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* 手動欄位對應面板（當必要欄位自動對應不到時顯示） */}
      {pendingManualFiles.length > 0 && (
        <div className="card manual-mapping-card">
          <h2>⚠️ 部分檔案需手動指定表頭對應</h2>
          <p className="muted">
            以下檔案的必要欄位（統編、名稱、地址、設立日）無法自動辨識，請由下拉選單選擇對應表頭：
          </p>
          {pendingManualFiles.map((pf, idx) => (
            <div key={pf.fileName} className="manual-file-box">
              <h3>
                檔案：{pf.fileName}（編碼：{pf.encoding.toUpperCase()}）
              </h3>
              <div className="mapping-grid">
                {(
                  [
                    ['taxId', '統編（必填）'],
                    ['name', '名稱（必填）'],
                    ['address', '地址（必填）'],
                    ['setupDate', '設立日（必填）'],
                    ['representative', '負責人（選填）'],
                    ['capital', '資本額（選填）'],
                    ['orgType', '組織種類（選填）'],
                  ] as const
                ).map(([fieldKey, label]) => (
                  <label key={fieldKey}>
                    {label}
                    <select
                      value={pf.mapping[fieldKey] || ''}
                      onChange={(e) =>
                        handleManualMappingChange(idx, fieldKey, e.target.value)
                      }
                    >
                      <option value="">-- 請選擇表頭欄位 --</option>
                      {pf.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="form-actions">
            <button
              className="btn btn-primary"
              disabled={pendingManualFiles.some(
                (f) => f.missingRequired.length > 0
              )}
              onClick={handleConfirmManualImport}
            >
              確認對應並執行匯入
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setPendingManualFiles([]);
                setReadyAutoFiles([]);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 匯入結果統計 */}
      {report && (
        <div className="card import-report-card">
          <div className="section-title-row">
            <h2>✅ 匯入結果統計</h2>
            <span className="muted">
              檔案：{report.filesProcessed.join('、')}
            </span>
          </div>

          <div className="stats-grid-5">
            <div className="stat-box">
              <span className="stat-label">讀取筆數</span>
              <strong className="stat-value">
                {report.totalRead.toLocaleString()}
              </strong>
            </div>
            <div className="stat-box stat-added">
              <span className="stat-label">新增筆數</span>
              <strong className="stat-value">
                {report.added.toLocaleString()}
              </strong>
            </div>
            <div className="stat-box stat-updated">
              <span className="stat-label">更新筆數</span>
              <strong className="stat-value">
                {report.updated.toLocaleString()}
              </strong>
            </div>
            <div className="stat-box stat-excluded">
              <span className="stat-label">排除筆數</span>
              <strong className="stat-value">
                {report.excluded.toLocaleString()}
              </strong>
            </div>
            <div className="stat-box stat-error">
              <span className="stat-label">錯誤／異常筆數</span>
              <strong className="stat-value">
                {report.errorCount.toLocaleString()}
              </strong>
            </div>
          </div>

          {report.errors.length > 0 && (
            <div className="error-report-section">
              <div className="section-title-row">
                <h3>錯誤與異常明細（共 {report.errors.length} 筆）</h3>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={handleDownloadErrorsCsv}
                >
                  ⬇️ 下載錯誤報表 CSV
                </button>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>檔案</th>
                      <th>列號</th>
                      <th>統編</th>
                      <th>名稱</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.errors.slice(0, 50).map((err, i) => (
                      <tr key={i}>
                        <td>{err.fileName}</td>
                        <td>{err.rowNumber}</td>
                        <td>
                          <code>{err.taxId}</code>
                        </td>
                        <td>{err.name}</td>
                        <td className="text-danger">{err.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
