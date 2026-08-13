# 錄音加入麥克風混音 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `recorder.html` 錄音時把麥克風聲音跟系統音訊混成一軌一起錄，麥克風權限被拒或無裝置時仍照常只錄系統音訊。

**Architecture:** 單一靜態 HTML 檔（無建置工具、無框架）。用 `AudioContext.createMediaStreamDestination()` 把 `getDisplayMedia` 的系統音軌與 `getUserMedia` 的麥克風音軌都 `connect()` 進同一個 destination，`MediaRecorder` 改錄這個合併後的 `destination.stream`。畫面音量表拆成系統音訊／麥克風兩條，各自掛獨立 `AnalyserNode`。

**Tech Stack:** 純 HTML/CSS/JavaScript（無 npm、無 bundler），瀏覽器原生 Web Audio API + MediaRecorder API + lamejs（既有 CDN script，不動）。

## Global Constraints

- 只支援 Windows + Chrome / Edge 桌面版（既有 README／頁面文案已聲明，不擴大支援範圍）
- 本 repo 沒有任何自動化測試框架、無 package.json、無 build step — 每個任務的驗證一律是「用 Chrome 或 Edge 直接開 `recorder.html`，手動操作＋看 DevTools console」，不要引入新的測試框架
- 上傳／Gemini 分析／MP3 轉檔（`encodeMp3`、`uploadAndAnalyze`、`gasPost`、`renderResult`）行為完全不能變 — 這些函式吃的是錄完的 `recordedBlob`，混音只影響錄音來源，不影響這些函式的輸入輸出格式
- `GAS_URL` 常數與既有上傳流程不得修改
- 只修改 `recorder.html`，不新增檔案
- spec 依據：`docs/superpowers/specs/2026-08-14-mic-mixing-design.md`

---

### Task 1: 音量表 UI 拆成系統音訊／麥克風兩條

**Files:**
- Modify: `recorder.html:13-14`（CSS，`#level`/`#levelBar` 規則）
- Modify: `recorder.html:47-51`（HTML，`.step` 區塊內的音量表＋按鈕）

**Interfaces:**
- Produces：兩個新的音量表元素 `id="sysLevelBar"`、`id="micLevelBar"`（皆為 `<div class="level-fill">`，外層各包一個 `<div class="level-track">`），供 Task 2 的 JS 用 `document.getElementById('sysLevelBar')` / `document.getElementById('micLevelBar')` 取得並更新 `style.width`
- Task 2 依賴這兩個確切 ID 存在於 DOM 中

- [ ] **Step 1: 修改 CSS，把 `#level`/`#levelBar` 改成可重複使用的 class**

把第 13-14 行：

```css
  #level{width:100%;height:24px;background:#000;border-radius:6px;overflow:hidden;margin-top:10px;}
  #levelBar{height:100%;width:0%;background:#4caf50;transition:width 0.05s;}
```

改成：

```css
  .level-track{width:100%;height:24px;background:#000;border-radius:6px;overflow:hidden;margin-top:6px;}
  .level-fill{height:100%;width:0%;background:#4caf50;transition:width 0.05s;}
```

- [ ] **Step 2: 修改 HTML，把單一音量表改成兩條**

把第 47-51 行：

```html
  <div class="step">
    <div style="font-size:13px;color:#888;margin-bottom:8px;">音量（有跳動 = 有收到聲音）</div>
    <div id="level"><div id="levelBar"></div></div>
    <button id="btnRecord" style="margin-top:14px;">● 開始錄音</button>
  </div>
```

改成：

```html
  <div class="step">
    <div style="font-size:13px;color:#888;margin-bottom:4px;">系統音訊（有跳動 = 有收到聲音）</div>
    <div class="level-track"><div id="sysLevelBar" class="level-fill"></div></div>
    <div style="font-size:13px;color:#888;margin:12px 0 4px;">麥克風</div>
    <div class="level-track"><div id="micLevelBar" class="level-fill"></div></div>
    <button id="btnRecord" style="margin-top:14px;">● 開始錄音</button>
  </div>
```

- [ ] **Step 3: 手動驗證**

用 Chrome 或 Edge 開啟 `recorder.html`（直接雙擊檔案，或拖進瀏覽器視窗）：
- 確認畫面出現兩條音量表，各自標示「系統音訊」「麥克風」
- 確認開啟 DevTools console 沒有紅字錯誤（此時 JS 還是舊邏輯，`getElementById('levelBar')` 會抓不到元素而報錯 —— 這是預期中的，Task 2 會修正，先確認頁面本身沒有其他非預期錯誤）

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\戴晨家\Documents\meeting-recorder-repo"
git add recorder.html
git commit -m "feat: 音量表拆成系統音訊/麥克風兩條"
```

---

### Task 2: 麥克風混音錄製邏輯

**Files:**
- Modify: `recorder.html:70`（變數宣告）
- Modify: `recorder.html:88`（DOM 參照，`levelBar` → `sysLevelBar`/`micLevelBar`）
- Modify: `recorder.html:105-151`（`startRecording`）
- Modify: `recorder.html:153-160`（`updateLevel`，新增 `readLevel` helper）
- Modify: `recorder.html:171-181`（`stopRecording`）

**Interfaces:**
- Consumes：Task 1 產生的 `#sysLevelBar`、`#micLevelBar` 元素
- Produces：`mediaRecorder` 錄的來源改為混音後的 `destination.stream`（原本是 `audioOnlyStream`，只有系統音訊）；下游的 `onRecordStop`／`encodeMp3`／`uploadAndAnalyze` 完全不用改，因為它們只依賴 `chunks`/`recordedBlob`，跟音源怎麼來的無關

- [ ] **Step 1: 修改變數宣告（第 70 行）**

把：

```js
let audioCtx, analyser, source, mediaRecorder, displayStream, audioOnlyStream;
```

改成：

```js
let audioCtx, sysAnalyser, micAnalyser, mediaRecorder, displayStream, micStream;
```

- [ ] **Step 2: 修改 DOM 參照（第 88 行）**

把：

```js
const levelBar  = document.getElementById('levelBar');
```

改成：

```js
const sysLevelBar = document.getElementById('sysLevelBar');
const micLevelBar = document.getElementById('micLevelBar');
```

- [ ] **Step 3: 修改 `startRecording`，加入麥克風擷取與混音（第 105-151 行）**

把整個 `startRecording` 函式：

```js
async function startRecording() {
  dlBtns.classList.remove('show');
  uploadBox.classList.remove('show');
  resultBox.classList.remove('show');
  resultBox.innerHTML = '';
  recordedBlob = null;
  uploadedFileId = null;
  unsavedWork = false;

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch(e) {
    status.innerHTML = '<span class="warn">取消或無法分享：' + e.message + '</span>';
    return;
  }

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    status.innerHTML = '<span class="warn">沒有抓到系統音訊！請重新點擊，分享時記得勾選「分享系統音訊」</span>';
    displayStream.getTracks().forEach(t => t.stop());
    return;
  }

  audioOnlyStream = new MediaStream(audioTracks);
  audioCtx = new AudioContext();
  source = audioCtx.createMediaStreamSource(audioOnlyStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  chunks = [];
  mediaRecorder = new MediaRecorder(audioOnlyStream);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = onRecordStop;
  mediaRecorder.start();
  unsavedWork = true;

  displayStream.getVideoTracks()[0].onended = () => { if (recording) stopRecording(); };

  recording = true;
  startTime = Date.now();
  btnRecord.textContent = '■ 停止錄音';
  btnRecord.classList.add('recording');
  status.innerHTML = '<span class="ok">已抓到系統音訊，錄音中</span>';
  updateLevel();
  updateTimer();
}
```

改成：

```js
async function startRecording() {
  dlBtns.classList.remove('show');
  uploadBox.classList.remove('show');
  resultBox.classList.remove('show');
  resultBox.innerHTML = '';
  recordedBlob = null;
  uploadedFileId = null;
  unsavedWork = false;

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch(e) {
    status.innerHTML = '<span class="warn">取消或無法分享：' + e.message + '</span>';
    return;
  }

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    status.innerHTML = '<span class="warn">沒有抓到系統音訊！請重新點擊，分享時記得勾選「分享系統音訊」</span>';
    displayStream.getTracks().forEach(t => t.stop());
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    micStream = null;
  }

  audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();

  const sysSource = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
  sysSource.connect(destination);
  sysAnalyser = audioCtx.createAnalyser();
  sysAnalyser.fftSize = 512;
  sysSource.connect(sysAnalyser);

  if (micStream && micStream.getAudioTracks().length > 0) {
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(destination);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micSource.connect(micAnalyser);
  } else {
    micAnalyser = null;
  }

  chunks = [];
  mediaRecorder = new MediaRecorder(destination.stream);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = onRecordStop;
  mediaRecorder.start();
  unsavedWork = true;

  displayStream.getVideoTracks()[0].onended = () => { if (recording) stopRecording(); };

  recording = true;
  startTime = Date.now();
  btnRecord.textContent = '■ 停止錄音';
  btnRecord.classList.add('recording');
  status.innerHTML = micStream
    ? '<span class="ok">已抓到系統音訊與麥克風，錄音中</span>'
    : '<span class="warn">未取得麥克風權限，僅錄系統音訊，錄音中</span>';
  updateLevel();
  updateTimer();
}
```

（注意：`audioOnlyStream`／`source`／`analyser` 三個舊變數已在 Step 1 從宣告中移除，這裡不再使用它們；`destination` 用 `const` 宣告在函式內，因為只有 `startRecording` 內部需要用來建立 `mediaRecorder`，不需要跨函式共用）

- [ ] **Step 4: 修改 `updateLevel`，改成同時更新兩條音量表（第 153-160 行）**

把：

```js
function updateLevel() {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  levelBar.style.width = Math.min(100, Math.sqrt(sum / data.length) * 300) + '%';
  if (recording) rafId = requestAnimationFrame(updateLevel);
}
```

改成：

```js
function readLevel(analyserNode) {
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  return Math.min(100, Math.sqrt(sum / data.length) * 300);
}

function updateLevel() {
  sysLevelBar.style.width = readLevel(sysAnalyser) + '%';
  micLevelBar.style.width = (micAnalyser ? readLevel(micAnalyser) : 0) + '%';
  if (recording) rafId = requestAnimationFrame(updateLevel);
}
```

- [ ] **Step 5: 修改 `stopRecording`，加入麥克風 stream 的清理（第 171-181 行）**

把：

```js
function stopRecording() {
  recording = false;
  recordedDuration = Math.floor((Date.now() - startTime) / 1000);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (displayStream) displayStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  cancelAnimationFrame(rafId);
  btnRecord.textContent = '● 開始錄音';
  btnRecord.classList.remove('recording');
  levelBar.style.width = '0%';
}
```

改成：

```js
function stopRecording() {
  recording = false;
  recordedDuration = Math.floor((Date.now() - startTime) / 1000);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (displayStream) displayStream.getTracks().forEach(t => t.stop());
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  cancelAnimationFrame(rafId);
  btnRecord.textContent = '● 開始錄音';
  btnRecord.classList.remove('recording');
  sysLevelBar.style.width = '0%';
  micLevelBar.style.width = '0%';
}
```

- [ ] **Step 6: 手動驗證 — 正常情境（系統音訊＋麥克風都授權）**

用 Chrome 或 Edge 開啟 `recorder.html`：
1. 點「開始錄音」，選「整個螢幕」並勾選「分享系統音訊」
2. 瀏覽器彈出麥克風權限請求時按「允許」
3. 確認狀態列顯示「已抓到系統音訊與麥克風，錄音中」
4. 對著麥克風講話，同時播放一段音樂／影片 → 確認「系統音訊」「麥克風」兩條音量表都會跳動
5. 點「停止錄音」，確認 DevTools console 無錯誤
6. 點「⬇ 下載 .webm（備份）」，播放下載的檔案 → 確認同時聽得到自己講話的聲音跟系統播放的聲音

- [ ] **Step 7: 手動驗證 — 麥克風被拒情境**

重新整理頁面：
1. 點「開始錄音」，選「整個螢幕」並勾選「分享系統音訊」
2. 瀏覽器彈出麥克風權限請求時按「封鎖」/「拒絕」
3. 確認狀態列顯示「未取得麥克風權限，僅錄系統音訊，錄音中」（不是中止或當掉）
4. 確認「系統音訊」音量表正常跳動，「麥克風」音量表維持在 0%
5. 停止錄音並下載 `.webm`，確認錄音正常（只有系統音訊，跟改動前行為一致）

- [ ] **Step 8: 手動驗證 — 既有功能不受影響**

沿用 Step 6 錄好的檔案：
1. 在備註欄輸入文字，點「☁ 上傳分析」
2. 確認上傳／轉 MP3／Gemini 分析／寫入 Sheet 的流程跟改動前一樣正常跑完，沒有因為混音而報錯

- [ ] **Step 9: Commit**

```bash
cd "C:\Users\戴晨家\Documents\meeting-recorder-repo"
git add recorder.html
git commit -m "feat: 錄音加入麥克風，與系統音訊混成一軌"
```

---

## 完成後

兩個 task 都 commit 完後，本機 `main` 分支會比 GitHub 上的 `origin/main` 多兩個 commit。**不要自動 push** —— push 前需要再跟用戶確認（會直接影響已部署的 GitHub Pages 網址 `https://stevetai0314-dot.github.io/meeting-recorder/recorder.html`，外銷部同仁在用）。
