# 外銷部會議錄音自動彙整工具 — 設計文件

日期：2026-07-07
狀態：已與用戶確認

## 目的

外銷部會議（一天約 40 分鐘、一週 5 次，中文）目前用瀏覽器工具錄系統音訊。
升級為：錄完 → 一鍵上傳 → 自動產出「按客人分段的彙整＋逐字稿」→ 存入
Google Sheet 台帳與 Obsidian 會議筆記，全程免手動整理。

會議內容結構：逐一討論多個客人（客人 A 的訊息 → 下一個客人 → …）。

## 已確認的決策

| 決策點 | 結論 |
|--------|------|
| 分析引擎 | Gemini API（NotebookLM 無 API，無法自動化） |
| 台帳 | 集中一張 Google Sheet，每列一場會議 |
| 追蹤單一客人 | 交給 Obsidian `[[客人名]]` 反向連結，不在 Sheet 切客人 |
| MD 進 Vault 方式 | Google Drive 桌面版同步資料夾到 `C:\Users\STEVE\Documents\Obsidian Vault` |
| 上傳前輸入 | 一格「會議備註」，選填 |
| 語言 | 中文 |

## 架構

```
前端（升級現有 line_recorder_v2_1.html）
  錄音 → 轉 MP3（16kHz 單聲道 32kbps，現有邏輯）
  → 填備註（選填）→ POST base64 到 GAS Web App
  → 頁面顯示進度與完成後的摘要

GAS Web App（新建）
  1. 收 MP3 → 存 Drive「外銷部會議錄音」資料夾
  2. 呼叫 Gemini API（金鑰存指令碼屬性）
     prompt：中文外銷部會議、按客人分段
     輸出 JSON：{ summary, customers: [{name, points[], todos[]}], transcript }
  3. 寫 Sheet 一列：日期時間、備註、摘要、逐字稿、MP3 連結、MD 連結
  4. 產 MD 檔存 Drive「會議記錄」資料夾（該資料夾由 Drive 桌面版同步進 Vault）
  5. 回傳摘要 JSON 給前端顯示
```

容量估算：40 分鐘 @32kbps ≈ 9.6MB，base64 後 ≈ 12.8MB。
低於 GAS POST 上限（50MB）與 Gemini inline 音訊上限（20MB）。
Gemini 處理 40 分鐘音訊約 2–4 分鐘，在 GAS 6 分鐘執行上限內。

## MD 格式

```markdown
---
date: 2026-07-07
type: 外銷部會議
---
# 外銷部會議 2026-07-07

## [[ABC公司]]
- 新單 500 打，交期 8 月
- 待辦：寄色卡

## [[XYZ公司]]
- 客訴縮率過大
- 待辦：回覆檢驗報告
```

- 客人名一律 `[[ ]]` 連結，供 Obsidian 反向連結追蹤歷次記錄
- 檔名：`外銷部會議 YYYY-MM-DD.md`；同日第二場自動加時間後綴避免覆蓋
- 逐字稿不放 MD（放 Sheet），MD 保持筆記可讀性

## 錯誤處理

- Gemini 分析失敗：MP3 照存 Drive，Sheet 記一列「待重新分析」＋錯誤原因，
  前端顯示失敗訊息；錄音不會弄丟
- 上傳失敗：前端保留 blob，可重按上傳或手動下載 MP3（現有下載按鈕保留）
- 前端在上傳前檢查 blob 存在、大小 > 0

## 一次性設定（需帶用戶操作，含介面路徑）

1. Google AI Studio（aistudio.google.com）申請免費 Gemini API 金鑰
2. 建 GAS 專案、貼 Code.gs、指令碼屬性存金鑰、部署 Web App（任何人可存取）
3. 建 Drive 資料夾「外銷部會議錄音」「會議記錄」
4. 安裝 Google Drive 桌面版，將「會議記錄」同步至 Obsidian Vault

## 明確不做（YAGNI）

- 常見客人名單對照（人名聽錯校正）— 實際跑過再評估
- 超長錄音（>2 小時）的非同步處理 — 會議固定 40 分鐘，不需要
- NotebookLM 整合 — 無 API；需要時手動把 MP3/MD 丟入即可

## 驗收標準

1. 錄一段含多「客人」段落的測試音訊，上傳後：
   - Sheet 出現一列，含摘要與完整逐字稿
   - Drive 有 MP3 與 MD 檔
   - MD 內每個客人為 `## [[名稱]]` 段落，含重點與待辦
   - 前端頁面顯示摘要
2. 拒絕分享系統音訊、上傳中斷、Gemini 回錯 — 各有明確錯誤訊息且錄音可救回
