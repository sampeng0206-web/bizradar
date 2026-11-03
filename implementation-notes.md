# 沃客買商機雷達（BizRadar）實作紀錄（Implementation Notes）

## 待釐清

1. **公司聯絡資訊（暫停點①待確認）**：
   - `COMPANY_ADDRESS`（公司地址，用於 Worker 變數與紙本信／Email 預設簽名檔）
   - `COMPANY_PHONE`（公司電話，用於問卷頁聯絡窗口、紙本信拒收電話與簽名檔）
   - `COMPANY_WEBSITE`（公司官網，用於紙本信與 Email 簽名檔）
2. **Cloudflare Worker Secrets（暫停點①由使用者於終端機手動輸入）**：
   - `RESEND_API_KEY`、`APP_TOKEN`、`LINK_SECRET`、`RESEND_WEBHOOK_SECRET` 需於首次部署後由使用者在終端機執行 `npx wrangler secret put <NAME>` 設定，絕不寫入程式碼或設定檔。
3. **Cloudflare D1 資料庫與 GitHub Pages 啟用（暫停點①、②、③待確認）**：
   - 建立 `bizradar-db`、套用 `0001_init.sql` migration 與首次執行 `npx wrangler deploy`。
   - 啟用 GitHub Pages 自動部署與 JSON 備份覆蓋還原功能上線確認。

## 決定

1. **核心資料與架構原則**：
   - **名單只存本機 IndexedDB**：所有公司／商業登記清冊名單（`leads`）、發送紀錄（`sends`）、既有客戶（`customers`）與系統設定（`settings`）僅儲存於使用者瀏覽器端 IndexedDB（透過 Dexie v1 管理），並於啟動時呼叫 `navigator.storage.persist()` 請求持久化儲存。
   - **CSV 每月手動匯入**：由使用者每月自政府資料開放平臺（公司設立登記清冊 `dataset/6047`、商業設立登記清冊 `dataset/6668`）下載最近 2–3 個月 CSV 拖放匯入，自動偵測 UTF-8（去 BOM）與 Big5 編碼。
   - **寄信走 Resend 子網域 `mail.workmateiia.com` 經 Worker**：前端經人工核准後，呼叫 Cloudflare Worker（`bizradar-mailer`）之 `POST /send`，由 Worker 以 `沃客買 <hello@mail.workmateiia.com>` 經 Resend API 發送純文字開發信，並附上 RFC 8058 One-Click Unsubscribe 標頭。
   - **問卷與拒收由 Worker 提供並自動同步**：Worker 與 D1（`bizradar-db`）僅儲存拒收名單（`suppressions`）、問卷回覆（`survey_responses`）、寄送紀錄（`send_log`）與退信／申訴事件（`email_events`），不存公司名單。前端啟動及每 10 分鐘透過 `GET /sync?since=ISO` 自動同步回本機 IndexedDB。
2. **經濟部商工行政資料開放平臺（GCIS）API 端點與 CORS 實測結果**：
   - 讀取 `https://data.gcis.nat.gov.tw/resources/swagger/swagger.json` 後，確認「公司登記基本資料-應用三」之正確端點為：
     - **Path**：`/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C`
     - **完整查詢 URL（`GCIS_URL`）**：
       `https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C?$format=json&$filter=Business_Accounting_NO eq {taxId}&$skip=0&$top=50`
     - **回傳欄位**：包含 `Business_Accounting_NO`、`Company_Name`、`Company_Status`、`Company_Status_Desc`（如 `"核准設立"`）、`Company_Setup_Date`、`Cmp_Business`（陣列，含 `Business_Seq_NO`、`Business_Item`、`Business_Item_Desc`）。
   - **雙向連線測試結果**：
     1. **瀏覽器直接 `fetch` 測試**：向 `https://data.gcis.nat.gov.tw/od/data/api/236EE382-4942-41A9-BD03-CA0709025E7C?...` 帶入 `Origin: http://localhost:5173`（或 `https://sampeng0206-web.github.io`）發送請求時，HTTP 狀態碼為 `200`，但回應標頭**未包含 `Access-Control-Allow-Origin`**（值為空），在瀏覽器環境下會因 CORS 政策遭阻擋（拋出 `TypeError: Failed to fetch`）。
     2. **Worker `/gcis` 代理查詢測試**：由伺服器端／Cloudflare Worker 發送相同請求不受瀏覽器同源政策限制，可正常取得完整 JSON 陣列（實測統編 `20828393` 回傳 `Company_Status_Desc: "核准設立"` 及 22 筆 `Cmp_Business` 營業項目代碼與說明），再由 Worker 加上 `Access-Control-Allow-Origin` 回傳前端。
     3. **前端補抓策略**：前端執行「補抓營業項目」時，先嘗試直接 `fetch` GCIS 端點；若因 CORS 失敗，自動切換呼叫 Worker `GET /gcis?taxId={taxId}` 並記錄連線模式。

## 偏離

- 目前無偏離規格之處。所有欄位、評分權重、營業項目與關鍵字規則、狀態流、端點行為與合規語氣（「可能」語氣、禁止「符合資格」與「保證」）皆嚴格遵循需求規格實作。

## 取捨

1. **純前端篩選與分頁效能**：台灣每月新設公司與行號約數千至上萬筆，2–3 個月資料量約 1.5 萬～3 萬筆。以 Dexie IndexedDB 配合記憶體內快速過濾與每頁 100 筆分頁渲染，可在 100ms 內完成多條件篩選（遠低於 1 秒上限），避免過度複雜的複合索引維護成本。
2. **GCIS 補抓速率限制**：為避免政府開放資料平臺封鎖 IP，前端補抓佇列嚴格限制每秒最多 1 筆（間隔 ≥ 1000ms），並支援隨時中斷與續傳（已補抓 `enrichedAt` 者自動跳過）。
3. **拒收連結安全性**：`GET /u` 僅顯示繁體中文確認頁與表單按鈕，實際寫入拒收由 `POST /u` 執行（同時相容郵件客戶端 RFC 8058 `List-Unsubscribe=One-Click` POST 請求），防止企業郵件安全掃描器預先爬取連結時誤觸拒收。
