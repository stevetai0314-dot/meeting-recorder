# 外銷部會議錄音工具 V3 實作計劃

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 錄音頁面錄完外銷部會議後一鍵上傳，GAS 呼叫 Gemini 自動產出逐字稿與按客人分段的彙整，寫入 Google Sheet 台帳並產生 Obsidian MD 筆記。

**Architecture:** 單檔前端（recorder.html，file:// 或 GitHub Pages 皆可）→ GAS Web App（doPost，action=upload/analyze 兩段式）→ Gemini API 兩段呼叫（音訊→逐字稿、逐字稿→JSON 摘要）→ Drive（MP3＋MD）＋ Sheet。MD 由 Google Drive 桌面版同步，Vault 內用 junction 指向同步資料夾。

**Tech Stack:** HTML/JS（lamejs MP3 編碼，沿用 V2）、Google Apps Script、Gemini API（gemini-2.5-flash）、Google Drive/Sheets。

## Global Constraints

- 語言：繁體中文介面與輸出
- CORS：前端 fetch 不得設定任何自訂 header（維持 simple request）；GAS 一律以 ContentService 回 JSON
- Gemini 金鑰只存 GAS 指令碼屬性 `GEMINI_API_KEY`，不得出現在前端
- Sheet 欄位順序：日期時間、備註、摘要、逐字稿、MP3連結、MD連結、狀態
- 逐字稿寫入 Sheet 前若超過 45000 字元須截斷並註記
- MD 檔名 `外銷部會議 YYYY-MM-DD.md`，同日已存在則改為 `外銷部會議 YYYY-MM-DD HH-mm.md`
- 時區 Asia/Taipei
- GAS 無法本機執行：測試步驟為「貼到 script.google.com 執行指定函式、核對 Logger 輸出」

---

### Task 1: GAS 骨架 — doGet/doPost 路由、上傳存檔、Sheet/資料夾自動建立

**Files:**
- Create: `gas/Code.gs`
- Create: `gas/appsscript.json`

**Interfaces:**
- Produces: `doPost` 接受 JSON `{action:'upload', filename, data(base64)}` 回 `{ok:true, fileId, sizeMB}`；`getOrCreateFolder(name, propKey)`、`getSheet()`、`jsonOut(obj)` 供 Task 2 使用
- 指令碼屬性鍵：`AUDIO_FOLDER_ID`、`MD_FOLDER_ID`、`SHEET_ID`、`GEMINI_API_KEY`

- [ ] **Step 1: 寫 `gas/appsscript.json`**

```json
{
  "timeZone": "Asia/Taipei",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

- [ ] **Step 2: 寫 `gas/Code.gs`（骨架部分）**

```javascript
// 外銷部會議錄音工具 V3 後端
const PROPS = PropertiesService.getScriptProperties();
const TZ = 'Asia/Taipei';

function doGet() {
  return ContentService.createTextOutput('OK meeting-recorder v3');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: '請求格式錯誤' });
  }
  try {
    if (req.action === 'upload')  return jsonOut(handleUpload(req));
    if (req.action === 'analyze') return jsonOut(handleAnalyze(req));
    return jsonOut({ ok: false, error: '未知的 action：' + req.action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message || err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder(name, propKey) {
  const id = PROPS.getProperty(propKey);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 被刪除，重建 */ }
  }
  const it = DriveApp.getFoldersByName(name);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PROPS.setProperty(propKey, folder.getId());
  return folder;
}

function getSheet() {
  const id = PROPS.getProperty('SHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { /* 被刪除，重建 */ }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('外銷部會議記錄');
    PROPS.setProperty('SHEET_ID', ss.getId());
    ss.getSheets()[0].appendRow(['日期時間', '備註', '摘要', '逐字稿', 'MP3連結', 'MD連結', '狀態']);
  }
  return ss.getSheets()[0];
}

function handleUpload(req) {
  if (!req.data) throw new Error('沒有收到音檔資料');
  const bytes = Utilities.base64Decode(req.data);
  if (bytes.length === 0) throw new Error('音檔是空的');
  const name = req.filename ||
    ('會議錄音_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HH-mm') + '.mp3');
  const blob = Utilities.newBlob(bytes, 'audio/mpeg', name);
  const folder = getOrCreateFolder('外銷部會議錄音', 'AUDIO_FOLDER_ID');
  const file = folder.createFile(blob);
  return { ok: true, fileId: file.getId(), sizeMB: (bytes.length / 1048576).toFixed(1) };
}
```

（`handleAnalyze` 在 Task 2 補上；此時先加一個暫時版避免 ReferenceError：）

```javascript
function handleAnalyze(req) {
  throw new Error('analyze 尚未實作');
}
```

- [ ] **Step 3: 加入骨架自我測試函式（同檔案末尾）**

```javascript
// 在 GAS 編輯器手動執行，核對 Logger 輸出
function testUploadSkeleton() {
  const fakeMp3 = Utilities.base64Encode(Utilities.newBlob('test-bytes').getBytes());
  const res = handleUpload({ action: 'upload', filename: 'test.mp3', data: fakeMp3 });
  Logger.log(res); // 期望 {ok=true, fileId=..., sizeMB=0.0}
  DriveApp.getFileById(res.fileId).setTrashed(true); // 清掉測試檔
  Logger.log(getSheet().getRange(1, 1, 1, 7).getValues()); // 期望表頭七欄
}
```

- [ ] **Step 4: Commit**

```bash
git add gas/Code.gs gas/appsscript.json
git commit -m "feat: GAS 骨架 — 路由、上傳存檔、Sheet/資料夾自動建立"
```

（實際貼到 script.google.com 執行 `testUploadSkeleton` 在 Task 4 設定時進行，因為需要用戶的 Google 帳號授權。）

---

### Task 2: Gemini 串接 — 逐字稿、JSON 摘要、MD 產生、Sheet 寫入

**Files:**
- Modify: `gas/Code.gs`（取代暫時版 `handleAnalyze`，新增下列函式）

**Interfaces:**
- Consumes: Task 1 的 `getOrCreateFolder`、`getSheet`、`PROPS`、`TZ`
- Produces: `handleAnalyze(req)` 接受 `{action:'analyze', fileId, note}` 回 `{ok:true, summary, customers, mdUrl}`；`customers` 為 `[{name, points[], todos[]}]`

- [ ] **Step 1: 寫 Gemini 呼叫層（追加到 Code.gs）**

```javascript
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function geminiCall(parts, generationConfig) {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('尚未設定 GEMINI_API_KEY（GAS 左側「專案設定」→ 指令碼屬性）');
  const payload = { contents: [{ parts: parts }] };
  if (generationConfig) payload.generationConfig = generationConfig;
  const res = UrlFetchApp.fetch(GEMINI_URL + '?key=' + key, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) throw new Error('Gemini API 錯誤 ' + code + '：' + body.slice(0, 300));
  const data = JSON.parse(body);
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(function (p) { return p.text || ''; }).join('')
    : '';
  if (!text) throw new Error('Gemini 沒有回傳內容：' + body.slice(0, 300));
  return text;
}

function geminiTranscribe(file) {
  const b64 = Utilities.base64Encode(file.getBlob().getBytes());
  return geminiCall([
    { inlineData: { mimeType: 'audio/mpeg', data: b64 } },
    { text: '這是一段台灣外銷部門的中文會議錄音。請輸出完整逐字稿（繁體中文）。' +
            '不需要時間碼，不要加標題或評論，直接輸出逐字稿本文。' }
  ]);
}

function geminiSummarize(transcript) {
  const prompt =
    '以下是外銷部會議逐字稿，會議內容是逐一討論多個客人。請整理成 JSON，格式：\n' +
    '{"summary":"整場會議 2~3 句摘要","customers":[{"name":"客人名稱","points":["重點"],"todos":["待辦事項"]}]}\n' +
    '規則：客人名稱用逐字稿中出現的稱呼；沒有待辦就給空陣列；全部使用繁體中文；只輸出 JSON。\n\n' +
    '逐字稿：\n' + transcript;
  const text = geminiCall([{ text: prompt }], { responseMimeType: 'application/json' });
  return JSON.parse(text);
}
```

- [ ] **Step 2: 寫 MD 產生與 Sheet 寫入（追加到 Code.gs）**

```javascript
function buildMarkdown(dateStr, note, result) {
  let md = '---\ndate: ' + dateStr + '\ntype: 外銷部會議\n---\n\n# 外銷部會議 ' + dateStr + '\n\n';
  if (note) md += '> 備註：' + note + '\n\n';
  if (result.summary) md += result.summary + '\n\n';
  (result.customers || []).forEach(function (c) {
    md += '## [[' + c.name + ']]\n';
    (c.points || []).forEach(function (p) { md += '- ' + p + '\n'; });
    (c.todos || []).forEach(function (t) { md += '- 待辦：' + t + '\n'; });
    md += '\n';
  });
  return md;
}

function saveMarkdown(dateStr, now, md) {
  const folder = getOrCreateFolder('會議記錄', 'MD_FOLDER_ID');
  let name = '外銷部會議 ' + dateStr + '.md';
  if (folder.getFilesByName(name).hasNext()) {
    name = '外銷部會議 ' + dateStr + ' ' + Utilities.formatDate(now, TZ, 'HH-mm') + '.md';
  }
  return folder.createFile(name, md, 'text/markdown');
}

function formatSummaryCell(result) {
  let s = result.summary || '';
  (result.customers || []).forEach(function (c) {
    s += '\n・' + c.name + '：' + (c.points || []).join('；');
    if ((c.todos || []).length) s += '【待辦】' + c.todos.join('；');
  });
  return s;
}

function appendRecord(sheet, dateTimeStr, note, result, transcript, mp3File, mdFile) {
  const t = transcript.length > 45000
    ? transcript.slice(0, 45000) + '\n…(過長截斷，完整內容請聽 MP3)'
    : transcript;
  sheet.appendRow([dateTimeStr, note, formatSummaryCell(result), t,
                   mp3File.getUrl(), mdFile.getUrl(), '完成']);
}
```

- [ ] **Step 3: 用正式版取代暫時版 `handleAnalyze`**

```javascript
function handleAnalyze(req) {
  if (!req.fileId) throw new Error('缺少 fileId');
  const file = DriveApp.getFileById(req.fileId);
  const note = req.note || '';
  const now = new Date();
  const dateStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const dateTimeStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm');
  const sheet = getSheet();

  let transcript, result;
  try {
    transcript = geminiTranscribe(file);
    result = geminiSummarize(transcript);
  } catch (err) {
    sheet.appendRow([dateTimeStr, note, '', '', file.getUrl(), '',
                     '待重新分析：' + String(err && err.message || err).slice(0, 200)]);
    throw err;
  }

  const md = buildMarkdown(dateStr, note, result);
  const mdFile = saveMarkdown(dateStr, now, md);
  appendRecord(sheet, dateTimeStr, note, result, transcript, file, mdFile);
  return { ok: true, summary: result.summary, customers: result.customers || [], mdUrl: mdFile.getUrl() };
}
```

- [ ] **Step 4: 加入測試函式（追加到 Code.gs 末尾）**

```javascript
// 設好 GEMINI_API_KEY 後在編輯器執行：期望 Logger 顯示「OK」
function testGeminiKey() {
  Logger.log(geminiCall([{ text: '請只回覆OK兩個字' }]));
}

// 純函式測試：期望輸出含 frontmatter、## [[ABC公司]]、- 待辦：寄色卡
function testBuildMarkdown() {
  const md = buildMarkdown('2026-07-07', '測試', {
    summary: '測試摘要。',
    customers: [{ name: 'ABC公司', points: ['新單500打'], todos: ['寄色卡'] }]
  });
  Logger.log(md);
  if (md.indexOf('## [[ABC公司]]') === -1) throw new Error('客人段落格式錯誤');
  if (md.indexOf('- 待辦：寄色卡') === -1) throw new Error('待辦格式錯誤');
  Logger.log('testBuildMarkdown PASS');
}
```

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs
git commit -m "feat: Gemini 兩段式分析、MD 產生、Sheet 寫入"
```

---

### Task 3: 前端 V3 — 備註輸入、上傳分析、結果顯示

**Files:**
- Modify: `recorder.html`（V2 基礎上改）

**Interfaces:**
- Consumes: GAS Web App URL（部署後貼入 `GAS_URL` 常數）；upload/analyze 的請求回應格式同 Task 1/2
- Produces: 完整可用的單檔前端

- [ ] **Step 1: 抽出共用 MP3 編碼函式**

把 V2 `convertAndDownloadMP3` 內的「解碼 webm → 重採樣 16kHz → lamejs 編碼」整段抽成：

```javascript
async function encodeMp3(webmBlob) {
  const arrayBuffer = await webmBlob.arrayBuffer();
  const decCtx = new AudioContext();
  const audioBuffer = await decCtx.decodeAudioData(arrayBuffer);
  await decCtx.close();

  const targetRate = 16000;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();

  const floatSamples = rendered.getChannelData(0);
  const int16 = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const encoder = new lamejs.Mp3Encoder(1, targetRate, 32);
  const mp3Parts = [];
  const chunkSize = 1152;
  for (let i = 0; i < int16.length; i += chunkSize) {
    const encoded = encoder.encodeBuffer(int16.subarray(i, i + chunkSize));
    if (encoded.length > 0) mp3Parts.push(new Uint8Array(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Parts.push(new Uint8Array(flushed));
  return new Blob(mp3Parts, { type: 'audio/mpeg' });
}
```

`convertAndDownloadMP3` 改為呼叫 `encodeMp3(recordedBlob)` 後下載（下載備援按鈕保留）。

- [ ] **Step 2: 加入上傳區 UI（HTML，放在 dlBtns 前面）**

```html
<div class="upload-box" id="uploadBox">
  <input id="noteInput" type="text" placeholder="會議備註（選填，例如：補開）">
  <button id="btnUpload">☁ 上傳分析（逐字稿＋彙整）</button>
</div>
<div id="result"></div>
```

CSS（加入 style 區）：

```css
.upload-box{display:none;width:100%;max-width:420px;flex-direction:column;gap:10px;margin-bottom:16px;}
.upload-box.show{display:flex;}
#noteInput{padding:12px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;font-size:15px;box-sizing:border-box;}
#btnUpload{background:#6a1b9a;color:white;font-size:16px;padding:16px;}
#btnUpload:disabled{background:#444;cursor:not-allowed;}
#result{display:none;background:#2a2a2a;border-radius:12px;padding:16px;width:100%;max-width:420px;margin-bottom:16px;box-sizing:border-box;font-size:14px;line-height:1.7;}
#result.show{display:block;}
#result h3{margin:10px 0 4px;font-size:15px;color:#ce93d8;}
```

標題改為「📞 通話收音工具 V3」，`onRecordStop` 裡加 `uploadBox.classList.add('show')`、清空 `result`。

- [ ] **Step 3: 加入上傳與分析邏輯（script 區）**

```javascript
const GAS_URL = '請貼上GAS部署網址';  // 部署後取代
let uploadedFileId = null;

const uploadBox = document.getElementById('uploadBox');
const noteInput = document.getElementById('noteInput');
const btnUpload = document.getElementById('btnUpload');
const resultBox = document.getElementById('result');

btnUpload.onclick = uploadAndAnalyze;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function gasPost(obj) {
  const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(obj) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '後端回傳錯誤');
  return data;
}

async function uploadAndAnalyze() {
  if (GAS_URL.indexOf('http') !== 0) {
    status.innerHTML = '<span class="warn">尚未設定 GAS 網址（開啟本檔案，把 GAS_URL 換成部署網址）</span>';
    return;
  }
  btnUpload.disabled = true;
  try {
    if (!uploadedFileId) {
      status.innerHTML = '<span class="ok">轉檔中…</span>';
      const mp3Blob = await encodeMp3(recordedBlob);
      status.innerHTML = '<span class="ok">上傳中…（' + (mp3Blob.size / 1048576).toFixed(1) + ' MB）</span>';
      const b64 = await blobToBase64(mp3Blob);
      const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
      const up = await gasPost({ action: 'upload', filename: '會議錄音_' + ts + '.mp3', data: b64 });
      uploadedFileId = up.fileId;
    }
    status.innerHTML = '<span class="ok">AI 分析中…約 2～4 分鐘，請勿關閉頁面</span>';
    const res = await gasPost({ action: 'analyze', fileId: uploadedFileId, note: noteInput.value.trim() });
    renderResult(res);
    status.innerHTML = '<span class="ok">完成！已寫入 Sheet 與會議記錄</span>';
    uploadedFileId = null;
  } catch (e) {
    status.innerHTML = '<span class="warn">失敗：' + e.message +
      '\n（若已等超過 5 分鐘，後端可能已完成，請先到 Sheet 查看再決定是否重試）</span>';
  } finally {
    btnUpload.disabled = false;
  }
}

function renderResult(res) {
  let html = '<h3>會議摘要</h3><div>' + escapeHtml(res.summary || '') + '</div>';
  (res.customers || []).forEach(c => {
    html += '<h3>' + escapeHtml(c.name) + '</h3><ul style="margin:4px 0;padding-left:20px;">';
    (c.points || []).forEach(p => html += '<li>' + escapeHtml(p) + '</li>');
    (c.todos || []).forEach(t => html += '<li>【待辦】' + escapeHtml(t) + '</li>');
    html += '</ul>';
  });
  resultBox.innerHTML = html;
  resultBox.classList.add('show');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
```

另外：`startRecording` 開頭要加 `uploadedFileId = null; uploadBox.classList.remove('show'); resultBox.classList.remove('show');`（新錄音清掉上一輪狀態）。

- [ ] **Step 4: 本機驗證（不需 GAS）**

用 Chrome 開 `recorder.html`：
- 錄 10 秒（分享螢幕勾系統音訊、放一段音樂）→ 停止 → 期望出現備註輸入框＋「☁ 上傳分析」按鈕＋兩顆下載按鈕
- 按「⬇ 下載 MP3」→ 期望正常下載可播放（驗證 encodeMp3 重構沒壞）
- 按「☁ 上傳分析」→ 期望顯示「尚未設定 GAS 網址」警告（GAS_URL 還是佔位字串）

- [ ] **Step 5: Commit**

```bash
git add recorder.html
git commit -m "feat: 前端 V3 — 備註輸入、上傳分析、結果顯示"
```

---

### Task 4: SETUP.md 設定指南＋實際部署（需用戶操作）

**Files:**
- Create: `SETUP.md`

**Interfaces:**
- Consumes: Task 1–3 的所有產出
- Produces: 已部署的 GAS Web App URL（回填 recorder.html 的 `GAS_URL`）

- [ ] **Step 1: 寫 `SETUP.md`**，內容涵蓋（每步都寫明網頁上實際點哪裡）：
  1. **申請 Gemini 金鑰**：開 aistudio.google.com → 左上「Get API key」→「建立 API 金鑰」→ 複製
  2. **建 GAS 專案**：script.google.com →「新專案」→ 貼 `gas/Code.gs` 內容 → 左側齒輪「專案設定」→ 勾「在編輯器中顯示 appsscript.json 資訊清單檔案」→ 貼 `gas/appsscript.json` → 同頁下方「指令碼屬性」→ 新增 `GEMINI_API_KEY`＝剛複製的金鑰
  3. **測試**：編輯器選 `testBuildMarkdown` 執行（第一次會跳授權，點「進階」→「前往…（不安全）」→ 允許）→ 再執行 `testGeminiKey`（期望 Logger 顯示 OK）→ 再執行 `testUploadSkeleton`
  4. **部署**：右上「部署」→「新增部署作業」→ 齒輪選「網頁應用程式」→ 執行身分「我」、存取權「所有人」→ 部署 → 複製 `/exec` 網址
  5. **回填前端**：把網址貼進 recorder.html 的 `GAS_URL`
  6. **Drive 桌面版同步**：安裝 Google Drive 桌面版 → 設定「我的雲端硬碟同步選項」選「鏡像檔案」→ 確認本機出現 `會議記錄` 資料夾 → 系統管理員 PowerShell 建 junction：
     `New-Item -ItemType Junction -Path "C:\Users\STEVE\Documents\Obsidian Vault\會議記錄" -Target "<鏡像路徑>\會議記錄"`
     （若不想裝 Drive 桌面版，備援：每天從 Drive 網頁下載 MD 拖進 Vault）
- [ ] **Step 2: 帶用戶實際完成 1–6**（互動進行，等用戶回報每步結果）
- [ ] **Step 3: 回填 `GAS_URL` 後 commit**

```bash
git add SETUP.md recorder.html
git commit -m "docs: 設定指南；chore: 回填 GAS_URL"
```

---

### Task 5: 端對端驗收

**Files:** 無新檔案

- [ ] **Step 1: 短錄音全流程測試**

用 recorder.html 錄 1–2 分鐘（放一段中文語音，例如 YouTube 新聞，內容提到兩個不同公司名），填備註「測試」，按上傳分析。逐項核對：
- 頁面顯示摘要與客人分段
- Sheet「外銷部會議記錄」多一列：日期時間、備註=測試、摘要、逐字稿、MP3 連結、MD 連結、狀態=完成
- Drive「外銷部會議錄音」有 MP3、「會議記錄」有 MD
- MD 內含 frontmatter 與 `## [[客人名]]` 段落
- Obsidian Vault 的「會議記錄」資料夾內看得到該 MD（junction＋同步生效），點 `[[客人名]]` 可建立連結

- [ ] **Step 2: 失敗路徑測試**
- 拒絕分享系統音訊 → 期望警告訊息、不進入錄音
- 暫時把指令碼屬性 `GEMINI_API_KEY` 改名 → 上傳分析 → 期望前端顯示「尚未設定 GEMINI_API_KEY…」、Sheet 出現「待重新分析」列、MP3 仍在 Drive → 改回屬性名，按重試（不重傳檔案）→ 期望成功
- 同一天上傳第二段 → 期望 MD 檔名帶 HH-mm 後綴

- [ ] **Step 3: 驗收通過後 commit tag**

```bash
git add -A
git commit -m "chore: V3 端對端驗收完成" --allow-empty
git tag v3.0
```
