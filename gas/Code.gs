// 外銷部會議錄音工具 V3 後端
const PROPS = PropertiesService.getScriptProperties();
const TZ = 'Asia/Taipei';

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'ping')        return jsonOut(handlePing());
  if (action === 'healthcheck') return jsonOut(handleHealthcheck());
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
    try { return DriveApp.getFolderById(id); } catch (e) { /* 資料夾被刪除，往下重建 */ }
  }
  const it = DriveApp.getFoldersByName(name);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PROPS.setProperty(propKey, folder.getId());
  return folder;
}

function getSpreadsheet() {
  const id = PROPS.getProperty('SHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { /* 試算表被刪除，往下重建 */ }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('外銷部會議記錄');
    PROPS.setProperty('SHEET_ID', ss.getId());
    ss.getSheets()[0].appendRow(['日期時間', '備註', '摘要', '逐字稿', 'MP3連結', 'MD連結', '狀態', '文件連結']);
  }
  return ss;
}

function getSheet() {
  const sheet = getSpreadsheet().getSheets()[0];
  // 舊試算表只有 7 欄表頭，補上第 8 欄
  if (sheet.getRange(1, 8).getValue() === '') sheet.getRange(1, 8).setValue('文件連結');
  return sheet;
}

function getGlossarySheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName('詞彙表');
  if (!sheet) {
    sheet = ss.insertSheet('詞彙表');
    sheet.appendRow(['專有名詞', '備註（選填）']);
  }
  return sheet;
}

function getGlossaryTerms() {
  const sheet = getGlossarySheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values
    .map(function (row) { return { term: String(row[0] || '').trim(), note: String(row[1] || '').trim() }; })
    .filter(function (row) { return row.term.length > 0; });
}

function buildGlossaryBlock() {
  const glossary = getGlossaryTerms();
  if (!glossary.length) return '';
  const lines = glossary.map(function (g) {
    return g.note ? '- ' + g.term + '（' + g.note + '）' : '- ' + g.term;
  });
  return '以下是本次會議常見的專有名詞正確寫法，遇到發音相近或不確定的詞，請優先採用這些寫法，不要自行意譯、音譯或簡化：\n' +
    lines.join('\n') + '\n\n';
}

function handleUpload(req) {
  if (!req.data) throw new Error('沒有收到音檔資料');
  const bytes = Utilities.base64Decode(req.data);
  if (bytes.length === 0) throw new Error('音檔是空的');
  const mimeType = req.mimeType || 'audio/mpeg';
  const name = req.filename ||
    ('會議錄音_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HH-mm') + '.mp3');
  const blob = Utilities.newBlob(bytes, mimeType, name);
  const folder = getOrCreateFolder('外銷部會議錄音', 'AUDIO_FOLDER_ID');
  const file = folder.createFile(blob);
  return { ok: true, fileId: file.getId(), sizeMB: (bytes.length / 1048576).toFixed(1) };
}

function handleAnalyze(req) {
  if (!req.fileId) throw new Error('缺少 fileId');
  const file = DriveApp.getFileById(req.fileId);
  const docFiles = (req.docFileIds || []).map(function (id) { return DriveApp.getFileById(id); });
  const docs = docFiles.map(function (f) { return { name: f.getName(), url: f.getUrl() }; });
  const docLinks = formatDocLinks(docs);
  const note = req.note || '';
  const now = new Date();
  const dateStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const dateTimeStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm');
  const sheet = getSheet();

  let transcript, warnings, result;
  try {
    const t = geminiTranscribe(file);
    transcript = t.text;
    warnings = t.warnings;
    result = geminiSummarize(transcript, docFiles);
  } catch (err) {
    const msg = String(err && err.message || err);
    const isQuota = msg.indexOf('429') !== -1 || msg.indexOf('RESOURCE_EXHAUSTED') !== -1;
    const statusText = isQuota ? '配額用完，隔日重試' : ('待重新分析：' + msg.slice(0, 200));
    sheet.appendRow([dateTimeStr, note, '', '', file.getUrl(), '', statusText, docLinks]);
    throw err;
  }

  const md = buildMarkdown(dateStr, note, result, docs);
  const mdFile = saveMarkdown(dateStr, now, md);
  const statusText = warnings.length ? '完成（逐字稿可能不完整：' + warnings.join('、') + '）' : '完成';
  appendRecord(sheet, dateTimeStr, note, result, transcript, file, mdFile, statusText, docLinks);
  return { ok: true, summary: result.summary, customers: result.customers || [],
           undiscussed: result.undiscussed, mdUrl: mdFile.getUrl() };
}

// ---------- Gemini ----------

const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_URL   = GEMINI_BASE + '/models/' + GEMINI_MODEL + ':generateContent';

// ---------- API 健康檢查 ----------

// 前端「測試 API」按鈕用：驗 key（免費）+ 打一個最小請求測配額
function handleHealthcheck() {
  const keyResult = checkGeminiKey();
  if (!keyResult.keyValid) {
    return { ok: true, keyValid: false, hasModel: false, quota: 'key_invalid', detail: keyResult.detail };
  }
  const quota = checkGeminiQuota();
  return { ok: true, keyValid: true, hasModel: keyResult.hasModel, quota: quota.status, detail: quota.detail };
}

// 只驗 key，不吃 generateContent 配額
function handlePing() {
  const keyResult = checkGeminiKey();
  return { ok: true, keyValid: keyResult.keyValid, hasModel: keyResult.hasModel, detail: keyResult.detail };
}

// 呼叫 models.list：跟 generateContent 分開的配額，等於免費
function checkGeminiKey() {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) return { keyValid: false, hasModel: false, detail: '尚未設定 GEMINI_API_KEY' };
  const res = UrlFetchApp.fetch(GEMINI_BASE + '/models?key=' + key, { method: 'get', muteHttpExceptions: true });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) {
    return { keyValid: false, hasModel: false, detail: 'models.list ' + code + '：' + body.slice(0, 200) };
  }
  let hasModel = false;
  try {
    const data = JSON.parse(body);
    hasModel = (data.models || []).some(function (m) {
      return String(m.name || '').indexOf(GEMINI_MODEL) !== -1;
    });
  } catch (err) { /* 解析失敗就當作沒找到模型 */ }
  return { keyValid: true, hasModel: hasModel, detail: hasModel ? '' : '找不到模型 ' + GEMINI_MODEL };
}

// 打一個最小的 generateContent，只看 HTTP 狀態碼判斷配額
function checkGeminiQuota() {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) return { status: 'key_invalid', detail: '尚未設定 GEMINI_API_KEY' };
  const payload = {
    contents: [{ parts: [{ text: '回OK' }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 5 }
  };
  const res = UrlFetchApp.fetch(GEMINI_URL + '?key=' + key, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code === 200) return { status: 'alive', detail: '' };
  return classifyGeminiError(code, body);
}

function classifyGeminiError(code, body) {
  const b = String(body || '');
  if (code === 429) return { status: 'quota_exhausted', detail: '免費層配額已用完，通常美西午夜後重置（約台灣下午 3~4 點）' };
  if (code === 404) return { status: 'model_unavailable', detail: '找不到模型 ' + GEMINI_MODEL };
  if (code === 400 && b.indexOf('API_KEY_INVALID') !== -1) return { status: 'key_invalid', detail: 'API key 無效' };
  if (code === 403) return { status: 'key_invalid', detail: 'API key 被拒（403）：' + b.slice(0, 150) };
  return { status: 'error', detail: code + '：' + b.slice(0, 200) };
}

function geminiRequest(parts, generationConfig) {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('尚未設定 GEMINI_API_KEY（GAS 左側「專案設定」→ 指令碼屬性）');
  const payload = { contents: [{ parts: parts }] };
  if (generationConfig) payload.generationConfig = generationConfig;
  return {
    url: GEMINI_URL + '?key=' + key,
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

// 回傳 { text, finishReason }；HTTP 錯誤或沒內容就丟例外
function parseGeminiResponse(res) {
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (isBusyCode(code)) {
    throw new Error('Gemini 伺服器忙線（' + code + '，已自動重試 ' + RETRY_WAITS_MS.length + ' 次），請過幾分鐘再按「上傳分析」');
  }
  if (code !== 200) throw new Error('Gemini API 錯誤 ' + code + '：' + body.slice(0, 300));
  const data = JSON.parse(body);
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(function (p) { return p.text || ''; }).join('')
    : '';
  if (!text) throw new Error('Gemini 沒有回傳內容：' + body.slice(0, 300));
  return { text: text, finishReason: (cand && cand.finishReason) || '' };
}

// Gemini 忙線（5xx）時等一下再試；429 配額用完、400 參數錯誤重試也沒用，不重試
const RETRY_WAITS_MS = [10000, 30000];

function isBusyCode(code) {
  return code === 500 || code === 502 || code === 503 || code === 504;
}

// 同時送出多個請求；忙線的那幾個等一下後只重送它們，回傳與 requests 同順序的回應
function fetchAllWithRetry(requests) {
  const responses = UrlFetchApp.fetchAll(requests);
  for (let i = 0; i < RETRY_WAITS_MS.length; i++) {
    const busy = [];
    responses.forEach(function (res, idx) { if (isBusyCode(res.getResponseCode())) busy.push(idx); });
    if (!busy.length) break;
    Utilities.sleep(RETRY_WAITS_MS[i]);
    const retried = UrlFetchApp.fetchAll(busy.map(function (idx) { return requests[idx]; }));
    busy.forEach(function (idx, k) { responses[idx] = retried[k]; });
  }
  return responses;
}

function geminiCall(parts, generationConfig) {
  const req = geminiRequest(parts, generationConfig);
  return parseGeminiResponse(fetchAllWithRetry([req])[0]).text;
}

// ---------- 分段轉逐字稿 ----------
// 長音檔一次丟給 Gemini 容易整段跳過，所以切成短段平行轉寫再接起來

const CHUNK_SECONDS   = 600; // 每段 10 分鐘
const OVERLAP_SECONDS = 5;   // 段與段重疊幾秒，避免切斷句子
const MIN_TAIL_SECONDS = 60; // 最後一段短於此就併入前一段

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// 解析 i 位置的 MP3 Layer III frame 標頭，不是合法標頭回 null
function parseMp3Header(bytes, i) {
  if (i + 4 > bytes.length) return null;
  const b0 = bytes[i] & 0xFF, b1 = bytes[i + 1] & 0xFF, b2 = bytes[i + 2] & 0xFF;
  if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;
  const version = (b1 >> 3) & 0x03;          // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (b1 >> 1) & 0x03;            // 1=Layer III
  if (version === 1 || layer !== 1) return null;
  const brIdx = (b2 >> 4) & 0x0F, srIdx = (b2 >> 2) & 0x03, pad = (b2 >> 1) & 0x01;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx];
  const sampleRate = MP3_SAMPLE_RATES[version][srIdx];
  const frameSize = Math.floor((version === 3 ? 144 : 72) * kbps * 1000 / sampleRate) + pad;
  return { frameSize: frameSize, bytesPerSec: kbps * 1000 / 8 };
}

// 從 pos 往後找第一個 frame 起點（連續兩個合法標頭才算，避免誤判音訊資料）
function findFrameStart(bytes, pos) {
  for (let i = Math.max(0, pos); i < bytes.length - 4; i++) {
    const h = parseMp3Header(bytes, i);
    if (!h) continue;
    if (i + h.frameSize >= bytes.length || parseMp3Header(bytes, i + h.frameSize)) return i;
  }
  return bytes.length;
}

// 把 CBR MP3 切成 [{ startSec, bytes }]，切點都落在 frame 起點
function splitMp3(bytes) {
  const first = findFrameStart(bytes, 0);
  const header = parseMp3Header(bytes, first);
  if (!header) return [{ startSec: 0, bytes: bytes }];
  const bps = header.bytesPerSec;
  const totalSec = (bytes.length - first) / bps;
  let count = Math.ceil(totalSec / CHUNK_SECONDS);
  if (count > 1 && totalSec - (count - 1) * CHUNK_SECONDS < MIN_TAIL_SECONDS) count--;
  if (count <= 1) return [{ startSec: 0, bytes: bytes }];

  const chunks = [];
  for (let k = 0; k < count; k++) {
    const startSec = k === 0 ? 0 : k * CHUNK_SECONDS - OVERLAP_SECONDS;
    const start = k === 0 ? 0 : findFrameStart(bytes, first + Math.floor(startSec * bps));
    const end = k === count - 1 ? bytes.length
      : findFrameStart(bytes, first + Math.floor((k + 1) * CHUNK_SECONDS * bps));
    chunks.push({ startSec: startSec, bytes: bytes.slice(start, end) });
  }
  return chunks;
}

function formatMmSs(sec) {
  const s = Math.max(0, Math.round(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// 回傳 { text, warnings[] }；warnings 記錄哪一段沒有正常結束
function geminiTranscribe(file) {
  const chunks = splitMp3(file.getBlob().getBytes());
  const glossaryBlock = buildGlossaryBlock();
  const requests = chunks.map(function (c, idx) {
    const where = chunks.length === 1 ? '' :
      '這是整場會議的第 ' + (idx + 1) + '/' + chunks.length + ' 段（約從 ' + formatMmSs(c.startSec) + ' 開始）' +
      (idx > 0 ? '，開頭約 ' + OVERLAP_SECONDS + ' 秒與上一段重疊' : '') + '。';
    return geminiRequest([
      { inlineData: { mimeType: 'audio/mpeg', data: Utilities.base64Encode(c.bytes) } },
      { text: glossaryBlock +
              '這是一段台灣外銷部門的中文會議錄音。' + where +
              '請從頭到尾逐句完整轉寫成繁體中文逐字稿，每一句發言都要寫出來，' +
              '不可省略、不可摘要、不可跳過任何段落；聽不清楚的地方寫［聽不清］。' +
              '換人講話時換行。不需要時間碼，不要加標題或評論，直接輸出逐字稿本文。' }
    ], { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 16384 });
  });

  const responses = fetchAllWithRetry(requests);
  const warnings = [];
  const parts = responses.map(function (res, idx) {
    const r = parseGeminiResponse(res);
    if (r.finishReason && r.finishReason !== 'STOP') {
      warnings.push('第' + (idx + 1) + '段 ' + r.finishReason);
    }
    return chunks.length === 1 ? r.text
      : '【第 ' + (idx + 1) + ' 段，約 ' + formatMmSs(chunks[idx].startSec) + ' 起】\n' + r.text.trim();
  });
  return { text: parts.join('\n\n'), warnings: warnings };
}

function geminiSummarize(transcript, docFiles) {
  docFiles = docFiles || [];
  const glossaryBlock = buildGlossaryBlock();
  const docRules = docFiles.length
    ? '本次會議附有討論文件（逐字稿之前的 PDF）。規則：以逐字稿為準整理客人重點與待辦；' +
      '逐字稿提到文件內容時，從文件補上具體數字、品號、交期、規格；客人名稱、品名、品號一律採用文件寫法；' +
      '文件中會議沒有討論到的內容不要寫進 customers，改列在 undiscussed（doc 填文件名稱）。\n'
    : '';
  const prompt =
    glossaryBlock + docRules +
    '以下是外銷部會議逐字稿，會議內容是逐一討論多個客人。請整理成 JSON，格式：\n' +
    '{"summary":"整場會議 2~3 句摘要","customers":[{"name":"客人名稱","points":["重點"],"todos":["待辦事項"]}]' +
    (docFiles.length ? ',"undiscussed":[{"doc":"文件名稱","item":"未討論的項目"}]' : '') + '}\n' +
    '規則：客人名稱用逐字稿中出現的稱呼；若上面列出專有名詞清單，內容中出現時請務必採用清單中的正確寫法；' +
    '沒有待辦就給空陣列；全部使用繁體中文；只輸出 JSON。\n\n' +
    '逐字稿：\n' + transcript;
  const parts = [];
  docFiles.forEach(function (f) {
    parts.push({ text: '文件名稱：' + f.getName() });
    parts.push({ inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(f.getBlob().getBytes()) } });
  });
  parts.push({ text: prompt });
  const result = JSON.parse(geminiCall(parts, { responseMimeType: 'application/json' }));
  result.undiscussed = normalizeUndiscussed(result);
  return result;
}

// ---------- MD 與 Sheet ----------

function normalizeUndiscussed(result) {
  return Array.isArray(result && result.undiscussed) ? result.undiscussed : [];
}

// MD 連結文字裡的方括號會讓連結失效，換成全形
function mdLinkText(name) {
  return String(name).replace(/\[/g, '［').replace(/\]/g, '］');
}

function buildMarkdown(dateStr, note, result, docs) {
  docs = docs || [];
  let md = '---\ndate: ' + dateStr + '\ntype: 外銷部會議\n---\n\n# 外銷部會議 ' + dateStr + '\n\n';
  if (note) md += '> 備註：' + note + '\n\n';
  if (result.summary) md += result.summary + '\n\n';
  (result.customers || []).forEach(function (c) {
    md += '## [[' + c.name + ']]\n';
    (c.points || []).forEach(function (p) { md += '- ' + p + '\n'; });
    (c.todos || []).forEach(function (t) { md += '- 待辦：' + t + '\n'; });
    md += '\n';
  });
  if (docs.length) {
    md += '## 會議文件\n';
    docs.forEach(function (d) { md += '- [' + mdLinkText(d.name) + '](' + d.url + ')\n'; });
    md += '\n';
    const undiscussed = normalizeUndiscussed(result);
    if (undiscussed.length) {
      md += '## 文件有、會議未討論\n';
      undiscussed.forEach(function (u) { md += '- ' + u.doc + '：' + u.item + '\n'; });
      md += '\n';
    }
  }
  return md;
}

function formatDocLinks(docs) {
  return (docs || []).map(function (d) { return d.name + ' ' + d.url; }).join('\n');
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

function appendRecord(sheet, dateTimeStr, note, result, transcript, mp3File, mdFile, statusText, docLinks) {
  const t = transcript.length > 45000
    ? transcript.slice(0, 45000) + '\n…(過長截斷，完整內容請聽 MP3)'
    : transcript;
  sheet.appendRow([dateTimeStr, note, formatSummaryCell(result), t,
                   mp3File.getUrl(), mdFile.getUrl(), statusText, docLinks || '']);
}

// ---------- 測試函式（在 GAS 編輯器手動執行） ----------

// 期望 Logger 顯示 {ok=true, ...}，並印出表頭七欄
function testUploadSkeleton() {
  const fakeMp3 = Utilities.base64Encode(Utilities.newBlob('test-bytes').getBytes());
  const res = handleUpload({ action: 'upload', filename: 'test.mp3', data: fakeMp3 });
  Logger.log(res);
  DriveApp.getFileById(res.fileId).setTrashed(true);
  Logger.log(getSheet().getRange(1, 1, 1, 7).getValues());
}

// 設好 GEMINI_API_KEY 後執行：印出 key 檢查結果（免費，不吃 generateContent 配額）
function testGeminiKey() {
  Logger.log(checkGeminiKey());
}

// 完整健康檢查：印出 key + 配額狀態（會打一個最小請求，吃 1 個免費層額度）
function testHealthcheck() {
  Logger.log(handleHealthcheck());
}

// 純函式測試：期望印出 MD 並顯示 PASS
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

// 純函式測試：附文件時有兩個新段落；檔名方括號轉全形；沒附文件時與現行相同
function testBuildMarkdownWithDocs() {
  const result = {
    summary: '測試摘要。',
    customers: [{ name: 'ABC公司', points: ['報價 USD 1.2/碼'], todos: [] }],
    undiscussed: [{ doc: '報價單[ABC].pdf', item: '第 3 項交期' }]
  };
  const docs = [{ name: '報價單[ABC].pdf', url: 'https://drive.google.com/x' }];
  const md = buildMarkdown('2026-10-05', '', result, docs);
  Logger.log(md);
  if (md.indexOf('## 會議文件\n- [報價單［ABC］.pdf](https://drive.google.com/x)') === -1) throw new Error('會議文件段落錯誤');
  if (md.indexOf('## 文件有、會議未討論\n- 報價單[ABC].pdf：第 3 項交期') === -1) throw new Error('未討論段落錯誤');

  const plain = buildMarkdown('2026-10-05', '', { summary: 'a', customers: [] });
  if (plain.indexOf('會議文件') !== -1 || plain.indexOf('未討論') !== -1) throw new Error('沒附文件卻出現文件段落');

  const noField = buildMarkdown('2026-10-05', '', { summary: 'a', customers: [], undiscussed: 'x' }, docs);
  if (noField.indexOf('未討論') !== -1) throw new Error('undiscussed 非陣列時應略過');

  if (formatDocLinks(docs) !== '報價單[ABC].pdf https://drive.google.com/x') throw new Error('formatDocLinks 錯誤');
  if (formatDocLinks([]) !== '') throw new Error('formatDocLinks 空陣列應回空字串');
  Logger.log('testBuildMarkdownWithDocs PASS');
}

// 舊試算表（只有 7 欄表頭）跑過 getSheet 後 H1 應為「文件連結」
function testDocHeader() {
  const sheet = getSheet();
  const h = sheet.getRange(1, 8).getValue();
  Logger.log('H1=' + h);
  if (h !== '文件連結') throw new Error('第 8 欄表頭沒補上');
  Logger.log('testDocHeader PASS');
}

// 真打 Gemini（吃 1 次額度）：拿 Drive 上一份 PDF 測整合摘要
// 使用前把 TEST_PDF_ID 換成「外銷部會議錄音」資料夾裡任一 PDF 的檔案 ID
function testSummarizeWithPdf() {
  const TEST_PDF_ID = '請貼上PDF檔案ID';
  const pdf = DriveApp.getFileById(TEST_PDF_ID);
  const result = geminiSummarize('主管：我們看一下這份文件第一項，這個沒問題。', [pdf]);
  Logger.log(JSON.stringify(result, null, 2));
  if (!Array.isArray(result.customers)) throw new Error('customers 不是陣列');
  if (!Array.isArray(normalizeUndiscussed(result))) throw new Error('undiscussed 處理錯誤');
  Logger.log('testSummarizeWithPdf PASS');
}
