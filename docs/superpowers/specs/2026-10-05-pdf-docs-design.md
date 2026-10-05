# 上傳討論文件（PDF）整合分析 — 設計文件

日期：2026-10-05
狀態：已與用戶確認

## 目的

外銷部會議除了口頭討論，也會對著文件（報價單、規格表、訂單等 PDF）討論。
目前只分析錄音，講到「這張報價單第二頁那個規格」時，彙整裡沒有實際數字。
改成上傳時可附 PDF，分析時與逐字稿整合。

## 已確認的決策

| 決策點 | 結論 |
|--------|------|
| 文件角色 | 口頭為主＋文件補細節：講到文件內容時從 PDF 補數字/品號/交期/規格；客人名、品名以文件寫法為準 |
| 文件沒討論到的內容 | 不寫進客人重點，另列「文件有、會議未討論」一段提醒 |
| PDF 進哪一段 Gemini | 只進第二段（整理 JSON），第一段分段轉逐字稿不變（方案 A） |
| PDF 選擇時機 | 錄完後在上傳區選，可多選 |
| 存放 | PDF 與 MP3 存同一個 Drive 資料夾 |

## 架構

```
前端 recorder.html
  上傳區：備註欄下方加 <input type=file accept=application/pdf multiple>
         選完列出檔名＋大小；PDF 合計 > 15MB 擋下並提示
  按「上傳分析」：
    1. 上傳 MP3（現行）
    2. 逐一上傳 PDF：gasPost({action:'upload', filename, mimeType:'application/pdf', data})
       已上傳成功的 fileId 記在 uploadedDocIds，失敗重按不重傳
    3. gasPost({action:'analyze', fileId, docFileIds, note})
  重新開始錄音時清空已選 PDF 與 uploadedDocIds

後端 Code.gs
  handleUpload：多收 req.mimeType（預設 audio/mpeg），存同一資料夾
  handleAnalyze：多收 req.docFileIds（可無）
    → 逐字稿（現行分段轉寫，不變）
    → geminiSummarize(transcript, docs)
       docs 以 inlineData(application/pdf) 送入，每份前面附「文件名稱：xxx」文字
    → MD、Sheet 多寫文件資訊
```

## Prompt 與 JSON

有附文件時，第二段 prompt 加規則：
- 以逐字稿為準整理客人重點與待辦
- 逐字稿提到文件內容時，從文件補上具體數字、品號、交期、規格
- 客人名稱、品名、品號一律採用文件寫法
- 文件中會議沒有討論到的內容，不要寫進 customers，改列在 undiscussed

JSON 格式：
```
{"summary":"...","customers":[{"name","points[]","todos[]"}],
 "undiscussed":[{"doc":"文件名稱","item":"未討論的項目"}]}
```
沒附文件時 prompt 與現行相同，undiscussed 給空陣列。

## 輸出

MD（附文件時才加這兩段，放在客人段落之後）：
```markdown
## 會議文件
- [報價單_ABC.pdf](Drive連結)

## 文件有、會議未討論
- 報價單_ABC.pdf：第 3 項 500 打交期
```

Sheet：最後加第 8 欄「文件連結」（多份換行），原 7 欄位置不變。
既有試算表第 1 列 H1 空白時自動補表頭。

## 錯誤處理

- PDF 合計 > 15MB：前端擋下，不送出（Gemini 單次請求大小上限）
- 分析失敗：MP3、PDF 已在 Drive，Sheet 記一列「待重新分析」（現行），文件連結欄照填
- 沒選 PDF：行為與現行完全相同

## 明確不做（YAGNI）

- PDF 送進第一段轉逐字稿（每段重送，吃配額）
- 從 PDF 自動抽詞併入詞彙表
- PDF 以外的格式（Word、Excel、圖片）— 需要時另開
- 錄音中途選文件

## 驗收標準

1. GAS 測試函式：buildMarkdown 附文件時有「會議文件」「文件有、會議未討論」段落；無文件時與現行相同
2. 真實會議＋1~2 份 PDF：彙整中討論到的文件項目帶出具體數字；未討論項目列在提醒段；Sheet 第 8 欄有連結
3. 不附 PDF 上傳：結果與現行版本一致
4. 選 > 15MB 的 PDF：前端擋下並提示
