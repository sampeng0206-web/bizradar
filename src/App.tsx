import React, { useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { db, getAppSettings, initPersistentStorage } from './db/database';
import { syncWithWorker } from './lib/sync';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { ImportPage } from './pages/ImportPage';
import { LeadsPage } from './pages/LeadsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';

export const App: React.FC = () => {
  const [newSurveyCount, setNewSurveyCount] = useState(0);

  useEffect(() => {
    initPersistentStorage();

    const runSync = async () => {
      try {
        await syncWithWorker(db);
      } catch {
        // 未設定 Worker 或離線時靜默略過
      } finally {
        const s = await getAppSettings(db);
        setNewSurveyCount(s.newSurveyCount || 0);
      }
    };

    // App 開啟時與每10分鐘呼叫 /sync
    runSync();
    const timer = setInterval(runSync, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <HashRouter>
      <div className="app-shell">
        <header className="top-nav no-print">
          <div className="brand-group">
            <span>📡 沃客買商機雷達 BizRadar</span>
            <span className="brand-sub">本機 IndexedDB 版</span>
          </div>
          <nav className="nav-links">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              名單與今日待辦
              {newSurveyCount > 0 && (
                <span className="nav-badge">新問卷 {newSurveyCount}</span>
              )}
            </NavLink>
            <NavLink
              to="/import"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              匯入清冊
            </NavLink>
            <NavLink
              to="/approval"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              核准佇列與列印
            </NavLink>
            <NavLink
              to="/reports"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              成效報表
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              設定與備份
            </NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<LeadsPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/approval" element={<ApprovalQueuePage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
};

export default App;
