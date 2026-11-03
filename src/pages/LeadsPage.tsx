import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LeadDetailDrawer } from '../components/LeadDetailDrawer';
import { db, getAppSettings } from '../db/database';
import { REGION_GROUPS, TAIWAN_CITIES } from '../lib/csvParser';
import { enrichSingleLeadWithGcis } from '../lib/gcis';
import { calculateDaysSinceSetup } from '../lib/scoring';
import { DEFAULT_SERVICES, getServiceMap } from '../lib/services';
import { Lead, LeadStatus, OrgType, ServiceDefinition } from '../types';

type DaysRangeOption = '30' | '60' | '90' | '60-90' | '150' | 'all';
type SortOption = 'score_desc' | 'date_desc';

const ALL_CITIES_WITH_UNKNOWN = [...TAIWAN_CITIES, '未知縣市'];
const PAGE_SIZE = 100;

export const LeadsPage: React.FC = () => {
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [services, setServices] =
    useState<ServiceDefinition[]>(DEFAULT_SERVICES);
  const [loading, setLoading] = useState(true);

  // 篩選條件
  const [daysFilter, setDaysFilter] = useState<DaysRangeOption>('90'); // 預設 3個月內
  const [selectedCities, setSelectedCities] = useState<Set<string>>(
    () => new Set(ALL_CITIES_WITH_UNKNOWN)
  );
  const [showCityCheckboxes, setShowCityCheckboxes] = useState(false);
  const [orgTypeFilter, setOrgTypeFilter] = useState<OrgType | 'all'>('all');
  const [minCapitalWan, setMinCapitalWan] = useState<string>('');
  const [maxCapitalWan, setMaxCapitalWan] = useState<string>('');
  const [minScore, setMinScore] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all');
  const [keyword, setKeyword] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortOption>('score_desc');
  const [currentPage, setCurrentPage] = useState<number>(1);

  // 右側建議卡
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  // 補抓營業項目佇列狀態
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<{
    done: number;
    total: number;
    currentName: string;
    mode?: string;
    error?: string;
  } | null>(null);
  const stopEnrichRef = useRef(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [leadsData, settings] = await Promise.all([
        db.leads.toArray(),
        getAppSettings(db),
      ]);
      setAllLeads(leadsData);
      setServices(settings.services);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const serviceMap = useMemo(() => getServiceMap(services), [services]);

  const filteredLeads = useMemo(() => {
    const now = new Date();
    const minCap =
      minCapitalWan.trim() !== '' ? Number(minCapitalWan) * 10000 : null;
    const maxCap =
      maxCapitalWan.trim() !== '' ? Number(maxCapitalWan) * 10000 : null;
    const kw = keyword.trim().toLowerCase();

    const list = allLeads.filter((lead) => {
      // 1. 設立天數
      if (daysFilter !== 'all') {
        const days = calculateDaysSinceSetup(lead.setupDate, now);
        if (daysFilter === '30' && days > 30) return false;
        if (daysFilter === '60' && days > 60) return false;
        if (daysFilter === '90' && days > 90) return false;
        if (daysFilter === '60-90' && (days < 60 || days > 90)) return false;
        if (daysFilter === '150' && days > 150) return false;
      }

      // 2. 地區
      if (
        selectedCities.size < ALL_CITIES_WITH_UNKNOWN.length &&
        !selectedCities.has(lead.city || '未知縣市')
      ) {
        return false;
      }

      // 3. 組織類型
      if (orgTypeFilter !== 'all' && lead.orgType !== orgTypeFilter) {
        return false;
      }

      // 4. 資本額區間
      if (minCap !== null && !Number.isNaN(minCap) && lead.capital < minCap) {
        return false;
      }
      if (maxCap !== null && !Number.isNaN(maxCap) && lead.capital > maxCap) {
        return false;
      }

      // 5. 分數下限
      if (minScore > 0 && lead.score < minScore) {
        return false;
      }

      // 6. 狀態
      if (statusFilter !== 'all' && lead.status !== statusFilter) {
        return false;
      }

      // 7. 關鍵字（名稱/地址/統編）
      if (kw) {
        const matchName = lead.name.toLowerCase().includes(kw);
        const matchAddr = lead.address.toLowerCase().includes(kw);
        const matchId = lead.id.toLowerCase().includes(kw);
        if (!matchName && !matchAddr && !matchId) return false;
      }

      return true;
    });

    // 排序：分數（預設）、設立日新到舊
    list.sort((a, b) => {
      if (sortBy === 'score_desc') {
        if (b.score !== a.score) return b.score - a.score;
        return b.setupDate.localeCompare(a.setupDate);
      } else {
        const cmp = b.setupDate.localeCompare(a.setupDate);
        if (cmp !== 0) return cmp;
        return b.score - a.score;
      }
    });

    return list;
  }, [
    allLeads,
    daysFilter,
    selectedCities,
    orgTypeFilter,
    minCapitalWan,
    maxCapitalWan,
    minScore,
    statusFilter,
    keyword,
    sortBy,
  ]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    daysFilter,
    selectedCities,
    orgTypeFilter,
    minCapitalWan,
    maxCapitalWan,
    minScore,
    statusFilter,
    keyword,
    sortBy,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / PAGE_SIZE));
  const paginatedLeads = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredLeads.slice(start, start + PAGE_SIZE);
  }, [filteredLeads, currentPage]);

  const handleSelectRegionGroup = (groupKey: string) => {
    if (groupKey === '全部') {
      setSelectedCities(new Set(ALL_CITIES_WITH_UNKNOWN));
      return;
    }
    const cities = REGION_GROUPS[groupKey] || [];
    setSelectedCities(new Set(cities));
  };

  const toggleSingleCity = (city: string) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) {
        next.delete(city);
      } else {
        next.add(city);
      }
      return next;
    });
  };

  // 只查 source='company' 且未補抓者，每秒最多1筆、可中途停止、顯示進度
  const unenrichedCompanyLeads = useMemo(
    () =>
      filteredLeads.filter(
        (l) => l.source === 'company' && !l.enrichedAt && l.status !== '排除'
      ),
    [filteredLeads]
  );

  const handleStartEnrich = async () => {
    const targets = unenrichedCompanyLeads;
    if (targets.length === 0) return;

    stopEnrichRef.current = false;
    setEnriching(true);
    setEnrichProgress({
      done: 0,
      total: targets.length,
      currentName: targets[0].name,
    });

    for (let i = 0; i < targets.length; i++) {
      if (stopEnrichRef.current) break;

      const target = targets[i];
      const startTime = Date.now();
      setEnrichProgress((prev) => ({
        done: i,
        total: targets.length,
        currentName: `${target.name} (${target.id})`,
        mode: prev?.mode,
      }));

      try {
        const { updatedLead, mode } = await enrichSingleLeadWithGcis(
          target,
          db
        );
        setAllLeads((prev) =>
          prev.map((item) => (item.id === updatedLead.id ? updatedLead : item))
        );
        if (selectedLead?.id === updatedLead.id) {
          setSelectedLead(updatedLead);
        }
        setEnrichProgress({
          done: i + 1,
          total: targets.length,
          currentName: `${target.name} (${target.id})`,
          mode: mode === 'direct' ? '瀏覽器直連 GCIS' : 'Worker /gcis 代理',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setEnrichProgress({
          done: i,
          total: targets.length,
          currentName: `${target.name} (${target.id})`,
          error: message,
        });
        break;
      }

      // 每秒最多 1 筆
      if (i < targets.length - 1 && !stopEnrichRef.current) {
        const elapsed = Date.now() - startTime;
        const waitMs = Math.max(0, 1000 - elapsed);
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }

    setEnriching(false);
  };

  const handleStopEnrich = () => {
    stopEnrichRef.current = true;
  };

  const handleLeadUpdated = (updated: Lead) => {
    setAllLeads((prev) =>
      prev.map((l) => (l.id === updated.id ? updated : l))
    );
    setSelectedLead(updated);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>商機名單篩選與評分</h1>
          <p className="subtitle">
            共篩選出 <strong>{filteredLeads.length.toLocaleString()}</strong> 筆（總庫存{' '}
            {allLeads.length.toLocaleString()} 筆）｜ 點擊任一列開啟右側「商機建議卡」
          </p>
        </div>
        <div className="header-actions">
          {!enriching ? (
            <button
              className="btn btn-accent"
              disabled={unenrichedCompanyLeads.length === 0}
              onClick={handleStartEnrich}
            >
              🔄 補抓營業項目（目前篩選結果：{unenrichedCompanyLeads.length} 筆待補）
            </button>
          ) : (
            <button className="btn btn-danger" onClick={handleStopEnrich}>
              ⏹ 停止補抓
            </button>
          )}
        </div>
      </div>

      {/* 補抓進度列 */}
      {enrichProgress && (
        <div className="card enrich-progress-card">
          <div className="section-title-row">
            <strong>
              補抓營業項目進度：{enrichProgress.done} / {enrichProgress.total} 筆
              {enrichProgress.mode ? `（模式：${enrichProgress.mode}）` : ''}
            </strong>
            <span className="muted">目前處理：{enrichProgress.currentName}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${Math.round(
                  (enrichProgress.done / Math.max(1, enrichProgress.total)) * 100
                )}%`,
              }}
            />
          </div>
          {enrichProgress.error && (
            <p className="text-danger" style={{ marginTop: 8 }}>
              ⚠️ {enrichProgress.error}
            </p>
          )}
        </div>
      )}

      {/* 篩選面板 */}
      <div className="card filter-card">
        <div className="filter-grid">
          <label>
            設立天數
            <select
              value={daysFilter}
              onChange={(e) => setDaysFilter(e.target.value as DaysRangeOption)}
            >
              <option value="30">1個月內（0–30天）</option>
              <option value="60">2個月內（0–60天）</option>
              <option value="90">3個月內（0–90天，預設）</option>
              <option value="60-90">60–90天（滿2–3個月）</option>
              <option value="150">5個月內（0–150天）</option>
              <option value="all">全部期間</option>
            </select>
          </label>

          <label>
            組織類型
            <select
              value={orgTypeFilter}
              onChange={(e) =>
                setOrgTypeFilter(e.target.value as OrgType | 'all')
              }
            >
              <option value="all">全部組織</option>
              <option value="股份有限公司">股份有限公司</option>
              <option value="有限公司">有限公司</option>
              <option value="行號">行號</option>
              <option value="其他">其他</option>
            </select>
          </label>

          <label>
            資本額區間（萬元）
            <div className="inline-inputs">
              <input
                type="number"
                placeholder="下限(萬)"
                value={minCapitalWan}
                onChange={(e) => setMinCapitalWan(e.target.value)}
              />
              <span>～</span>
              <input
                type="number"
                placeholder="上限(萬)"
                value={maxCapitalWan}
                onChange={(e) => setMaxCapitalWan(e.target.value)}
              />
            </div>
          </label>

          <label>
            分數下限（{minScore} 分以上）
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
          </label>

          <label>
            狀態
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as LeadStatus | 'all')
              }
            >
              <option value="all">全部狀態</option>
              <option value="新線索">新線索</option>
              <option value="待查核">待查核</option>
              <option value="待核准">待核准</option>
              <option value="已寄Email">已寄Email</option>
              <option value="已寄紙本">已寄紙本</option>
              <option value="有興趣">有興趣</option>
              <option value="未回覆">未回覆</option>
              <option value="洽談中">洽談中</option>
              <option value="已報價">已報價</option>
              <option value="成交">成交</option>
              <option value="未成交">未成交</option>
              <option value="拒絕">拒絕</option>
              <option value="退件">退件</option>
              <option value="排除">排除</option>
            </select>
          </label>

          <label>
            排序方式
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
            >
              <option value="score_desc">分數高到低（預設）</option>
              <option value="date_desc">設立日新到舊</option>
            </select>
          </label>

          <label className="span-2">
            關鍵字搜尋（名稱／地址／統編）
            <input
              type="text"
              placeholder="輸入公司名稱、地址路名或8碼統編..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
        </div>

        {/* 地區快選與逐一勾選 */}
        <div className="region-filter-bar">
          <div className="region-quick-btns">
            <span className="filter-label">地區快選：</span>
            {(['全部', '北部', '中部', '南部', '東部', '離島'] as const).map(
              (region) => (
                <button
                  key={region}
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => handleSelectRegionGroup(region)}
                >
                  {region}
                </button>
              )
            )}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setShowCityCheckboxes((v) => !v)}
            >
              {showCityCheckboxes
                ? '▲ 收合縣市勾選'
                : `▼ 逐一勾選縣市（已選 ${selectedCities.size}）`}
            </button>
          </div>

          {showCityCheckboxes && (
            <div className="city-checkbox-grid">
              {ALL_CITIES_WITH_UNKNOWN.map((city) => (
                <label key={city} className="city-checkbox-item">
                  <input
                    type="checkbox"
                    checked={selectedCities.has(city)}
                    onChange={() => toggleSingleCity(city)}
                  />
                  <span>{city}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 資料表 */}
      <div className="card table-card">
        {loading ? (
          <p className="muted">載入名單中...</p>
        ) : paginatedLeads.length === 0 ? (
          <p className="muted">
            目前沒有符合篩選條件的名單。請調整篩選條件或前往「匯入清冊」頁匯入官方 CSV。
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table interactive-table">
                <thead>
                  <tr>
                    <th style={{ width: 72 }}>分數</th>
                    <th>名稱</th>
                    <th style={{ width: 120 }}>縣市區</th>
                    <th style={{ width: 140 }}>設立日(天數)</th>
                    <th style={{ width: 110 }}>資本額(萬)</th>
                    <th>推薦服務標籤</th>
                    <th style={{ width: 100 }}>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedLeads.map((lead) => {
                    const days = calculateDaysSinceSetup(lead.setupDate);
                    return (
                      <tr
                        key={lead.id}
                        onClick={() => setSelectedLead(lead)}
                        className={
                          selectedLead?.id === lead.id ? 'row-selected' : ''
                        }
                      >
                        <td>
                          <span
                            className={`score-pill ${
                              lead.score >= 70
                                ? 'score-high'
                                : lead.score >= 50
                                  ? 'score-mid'
                                  : 'score-low'
                            }`}
                          >
                            {lead.score}
                          </span>
                        </td>
                        <td>
                          <div className="lead-name-cell">
                            <strong>{lead.name}</strong>
                            <span className="muted-code">
                              {lead.id} · {lead.orgType}
                              {lead.email ? ' · ✉️' : ''}
                              {lead.enrichedAt ? ' · 🏢已補抓' : ''}
                            </span>
                          </div>
                        </td>
                        <td>
                          {lead.city}
                          {lead.district ? ` ${lead.district}` : ''}
                        </td>
                        <td>
                          {lead.setupDate}{' '}
                          <span className="muted">({days}天)</span>
                        </td>
                        <td className="num-cell">
                          {(lead.capital / 10000).toLocaleString(undefined, {
                            maximumFractionDigits: 1,
                          })}
                        </td>
                        <td>
                          <div className="service-tags-cell">
                            {lead.services.slice(0, 4).map((code) => {
                              const def = serviceMap.get(code);
                              return (
                                <span
                                  key={code}
                                  className="service-tag"
                                  title={def?.name || code}
                                >
                                  {code} {def ? def.name.slice(0, 6) : ''}
                                </span>
                              );
                            })}
                            {lead.services.length > 4 && (
                              <span className="service-tag">
                                +{lead.services.length - 4}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={`status-tag status-${lead.status}`}>
                            {lead.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 分頁控制（每頁100筆） */}
            <div className="pagination-bar">
              <span className="muted">
                顯示第 {(currentPage - 1) * PAGE_SIZE + 1} ～{' '}
                {Math.min(currentPage * PAGE_SIZE, filteredLeads.length)} 筆（共{' '}
                {filteredLeads.length.toLocaleString()} 筆，每頁 {PAGE_SIZE} 筆）
              </span>
              <div className="pagination-btns">
                <button
                  className="btn btn-sm btn-outline"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  上一頁
                </button>
                <span className="page-indicator">
                  第 {currentPage} / {totalPages} 頁
                </span>
                <button
                  className="btn btn-sm btn-outline"
                  disabled={currentPage >= totalPages}
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                >
                  下一頁
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 右側商機建議卡 Drawer */}
      <LeadDetailDrawer
        lead={selectedLead}
        services={services}
        onClose={() => setSelectedLead(null)}
        onUpdated={handleLeadUpdated}
      />
    </div>
  );
};
