import React, { useEffect, useMemo, useState } from 'react';
import { db } from '../db/database';
import { Lead, SendRecord, SurveyRecord } from '../types';

export const ReportsPage: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [surveys, setSurveys] = useState<SurveyRecord[]>([]);
  const [selectedImportMonth, setSelectedImportMonth] = useState<string>('all');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  useEffect(() => {
    Promise.all([
      db.leads.toArray(),
      db.sends.toArray(),
      db.surveys.toArray(),
    ]).then(([l, s, sv]) => {
      setLeads(l);
      setSends(s);
      setSurveys(sv);
    });
  }, []);

  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    for (const l of leads) {
      if (l.importedAt && l.importedAt.length >= 7) {
        months.add(l.importedAt.slice(0, 7));
      }
    }
    return Array.from(months).sort().reverse();
  }, [leads]);

  const filteredLeads = useMemo(() => {
    return leads.filter((l) => {
      if (
        selectedImportMonth !== 'all' &&
        !l.importedAt?.startsWith(selectedImportMonth)
      ) {
        return false;
      }
      if (startDate && l.setupDate < startDate) return false;
      if (endDate && l.setupDate > endDate) return false;
      return true;
    });
  }, [leads, selectedImportMonth, startDate, endDate]);

  const stats = useMemo(() => {
    const leadIds = new Set(filteredLeads.map((l) => l.id));
    const totalImported = filteredLeads.length;

    // 資料可用率：非「排除」且具備有效縣市地址或 Email
    const usableCount = filteredLeads.filter(
      (l) =>
        l.status !== '排除' &&
        ((l.address && l.city !== '未知縣市') || Boolean(l.email?.trim()))
    ).length;
    const usableRate =
      totalImported > 0 ? ((usableCount / totalImported) * 100).toFixed(1) : '0.0';

    // 進入待核准數（目前或歷史曾進入待核准或已寄送後狀態）
    const enteredApprovalCount = filteredLeads.filter(
      (l) =>
        l.status === '待核准' ||
        (l.contactCount || 0) > 0 ||
        (l.statusHistory || []).some((h) => h.status === '待核准')
    ).length;

    // 發送紀錄統計
    const relevantSends = sends.filter((s) => leadIds.has(s.leadId));
    const emailSent = relevantSends.filter(
      (s) => s.channel === 'email' && s.result === 'sent'
    ).length;
    const emailFailed = relevantSends.filter(
      (s) => s.channel === 'email' && s.result === 'failed'
    ).length;
    const emailBounced = relevantSends.filter(
      (s) => s.channel === 'email' && s.result === 'bounced'
    ).length;

    const letterSent = relevantSends.filter(
      (s) => s.channel === 'letter' && s.result === 'sent'
    ).length;
    const letterReturned = relevantSends.filter(
      (s) => s.channel === 'letter' && s.result === 'returned'
    ).length;
    const letterReturnRate =
      letterSent > 0 ? ((letterReturned / letterSent) * 100).toFixed(1) : '0.0';

    // 問卷回覆數與回覆率
    const relevantSurveys = surveys.filter((sv) => leadIds.has(sv.taxId));
    const surveyCount = relevantSurveys.length;
    const totalOutreach = emailSent + letterSent;
    const surveyResponseRate =
      totalOutreach > 0
        ? ((surveyCount / totalOutreach) * 100).toFixed(1)
        : '0.0';

    // 漏斗狀態統計
    const countByStage = (target: string) =>
      filteredLeads.filter(
        (l) =>
          l.status === target ||
          (l.statusHistory || []).some((h) => h.status === target)
      ).length;

    return {
      totalImported,
      usableCount,
      usableRate,
      enteredApprovalCount,
      emailSent,
      emailFailed,
      emailBounced,
      letterSent,
      letterReturned,
      letterReturnRate,
      surveyCount,
      totalOutreach,
      surveyResponseRate,
      interested: countByStage('有興趣'),
      negotiating: countByStage('洽談中'),
      quoted: countByStage('已報價'),
      won: countByStage('成交'),
    };
  }, [filteredLeads, sends, surveys]);

  const isSmallSample =
    stats.totalImported < 30 || stats.totalOutreach < 30;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>開發漏斗與成效報表</h1>
          <p className="subtitle">
            依匯入月份與設立期間檢視：匯入數、資料可用率、Email／紙本發送、問卷回覆率與成交轉化
          </p>
        </div>
      </div>

      {/* 篩選列 */}
      <div className="card">
        <div className="filter-grid">
          <label>
            匯入月份
            <select
              value={selectedImportMonth}
              onChange={(e) => setSelectedImportMonth(e.target.value)}
            >
              <option value="all">全部匯入月份</option>
              {availableMonths.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            設立日期起
            <input
              type="text"
              placeholder="yyyy-mm-dd"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label>
            設立日期迄
            <input
              type="text"
              placeholder="yyyy-mm-dd"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* 樣本 < 30 警告標示 */}
      {isSmallSample && (
        <div
          className="card"
          style={{ borderColor: '#f59e0b', background: '#fffbeb' }}
        >
          <strong>⚠️ 樣本太小，比率僅供參考</strong>
          <span className="muted" style={{ marginLeft: 8 }}>
            （目前篩選匯入樣本數：{stats.totalImported} 筆，總寄出樣本數：
            {stats.totalOutreach} 筆，未達 30 筆統計門檻）
          </span>
        </div>
      )}

      {/* 核心指標卡 */}
      <div className="stats-grid-5">
        <div className="stat-box">
          <span className="stat-label">匯入數</span>
          <strong className="stat-value">
            {stats.totalImported.toLocaleString()}
          </strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">資料可用率</span>
          <strong className="stat-value">{stats.usableRate}%</strong>
          <span className="muted-code">可用 {stats.usableCount} 筆</span>
        </div>
        <div className="stat-box">
          <span className="stat-label">進入待核准數</span>
          <strong className="stat-value">
            {stats.enteredApprovalCount.toLocaleString()}
          </strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">問卷回覆數 / 回覆率</span>
          <strong className="stat-value">
            {stats.surveyCount} ({stats.surveyResponseRate}%)
          </strong>
          {stats.totalOutreach < 30 && (
            <span className="muted-code">樣本太小，比率僅供參考</span>
          )}
        </div>
        <div className="stat-box">
          <span className="stat-label">紙本寄送 / 退件率</span>
          <strong className="stat-value">
            {stats.letterSent} ({stats.letterReturnRate}%)
          </strong>
          <span className="muted-code">退件 {stats.letterReturned} 筆</span>
        </div>
      </div>

      {/* 詳細表格 */}
      <div className="form-row-2">
        <div className="card">
          <h3>發送管道與退信／退件統計</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>項目</th>
                <th>筆數 / 比率</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Email 發送成功</td>
                <td>
                  <strong>{stats.emailSent}</strong>
                </td>
                <td>經 Resend 成功投遞</td>
              </tr>
              <tr>
                <td>Email 發送失敗</td>
                <td>{stats.emailFailed}</td>
                <td>API 錯誤或網路異常</td>
              </tr>
              <tr>
                <td>Email 退信 (Bounced)</td>
                <td className="text-danger">{stats.emailBounced}</td>
                <td>Webhook 自動回寫退件與拒收</td>
              </tr>
              <tr>
                <td>紙本開發信寄送</td>
                <td>
                  <strong>{stats.letterSent}</strong>
                </td>
                <td>A4 開發信＋回郵意向單</td>
              </tr>
              <tr>
                <td>紙本退件數 / 退件率</td>
                <td>
                  {stats.letterReturned} 筆 ({stats.letterReturnRate}%)
                </td>
                <td>
                  {stats.letterSent < 30
                    ? '樣本太小，比率僅供參考'
                    : '正常統計樣本'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>商機轉換漏斗（追蹤到成交）</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>漏斗階段</th>
                <th>累計家數</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1. 進入待核准</td>
                <td>{stats.enteredApprovalCount}</td>
              </tr>
              <tr>
                <td>2. 問卷回覆數（回覆率 {stats.surveyResponseRate}%）</td>
                <td>{stats.surveyCount}</td>
              </tr>
              <tr>
                <td>3. 有興趣</td>
                <td>
                  <strong>{stats.interested}</strong>
                </td>
              </tr>
              <tr>
                <td>4. 洽談中</td>
                <td>
                  <strong>{stats.negotiating}</strong>
                </td>
              </tr>
              <tr>
                <td>5. 已報價</td>
                <td>
                  <strong>{stats.quoted}</strong>
                </td>
              </tr>
              <tr>
                <td>6. 成交</td>
                <td>
                  <strong style={{ color: '#166534', fontSize: 16 }}>
                    {stats.won}
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
