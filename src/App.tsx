import React, { useEffect } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { initPersistentStorage } from './db/database';
import { ImportPage } from './pages/ImportPage';
import { LeadsPage } from './pages/LeadsPage';

export const App: React.FC = () => {
  useEffect(() => {
    initPersistentStorage();
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
              名單篩選與建議卡
            </NavLink>
            <NavLink
              to="/import"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              匯入清冊
            </NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<LeadsPage />} />
            <Route path="/import" element={<ImportPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
};

export default App;
