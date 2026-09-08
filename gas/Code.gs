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
    ss.getSheets()[0].appendRow(['日期時間', '備註', '摘要', '逐字稿', 'MP3連結', 'MD連結', '狀態']);
  }
  return ss;
}

function getSheet() {
  return getSpreadsheet().getSheets()[0];
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
  const name = req.filename ||
    ('會議錄音_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HH-mm') + '.mp3');
  const blob = Utilities.newBlob(bytes, 'audio/mpeg', name);
  const folder = getOrCreateFolder('外銷部會議錄音', 'AUDIO_FOLDER_ID');
  const file = folder.createFile(blob);
  return { ok: true, fileId: file.getId(), sizeMB: (bytes.length / 1048576).toFixed(1) };
}

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
    const msg = String(err && err.message || err);
    const isQuota = msg.indexOf('429') !== -1 || msg.indexOf('RESOURCE_EXHAUSTED') !== -1;
    const statusText = isQuota ? '配額用完，隔日重試' : ('待重新分析：' + msg.slice(0, 200));
    sheet.appendRow([dateTimeStr, note, '', '', file.getUrl(), '', statusText]);
    throw err;
  }

  const md = buildMarkdown(dateStr, note, result);
  const mdFile = saveMarkdown(dateStr, now, md);
  appendRecord(sheet, dateTimeStr, note, result, transcript, file, mdFile);
  return { ok: true, summary: result.summary, customers: result.customers || [], mdUrl: mdFile.getUrl() };
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
  const glossaryBlock = buildGlossaryBlock();
  return geminiCall([
    { inlineData: { mimeType: 'audio/mpeg', data: b64 } },
    { text: glossaryBlock +
            '這是一段台灣外銷部門的中文會議錄音。請輸出完整逐字稿（繁體中文）。' +
            '不需要時間碼，不要加標題或評論，直接輸出逐字稿本文。' }
  ], { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 65536 });
}

function geminiSummarize(transcript) {
  const glossaryBlock = buildGlossaryBlock();
  const prompt =
    glossaryBlock +
    '以下是外銷部會議逐字稿，會議內容是逐一討論多個客人。請整理成 JSON，格式：\n' +
    '{"summary":"整場會議 2~3 句摘要","customers":[{"name":"客人名稱","points":["重點"],"todos":["待辦事項"]}]}\n' +
    '規則：客人名稱用逐字稿中出現的稱呼；若上面列出專有名詞清單，內容中出現時請務必採用清單中的正確寫法；' +
    '沒有待辦就給空陣列；全部使用繁體中文；只輸出 JSON。\n\n' +
    '逐字稿：\n' + transcript;
  const text = geminiCall([{ text: prompt }], { responseMimeType: 'application/json' });
  return JSON.parse(text);
}

// ---------- MD 與 Sheet ----------

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
