// ---- Device Information ----
(() => {
  const NA = 'Not available';
  const ua = navigator.userAgent;
  const uaData = navigator.userAgentData;
  const $ = id => document.getElementById(id);

  const isIPad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  let device = 'Desktop';
  if (/iPad/i.test(ua) || isIPad) device = 'Tablet';
  else if (/Android/i.test(ua) && !/Mobi/i.test(ua)) device = 'Tablet';
  else if (/Mobi|Android|iPhone|iPod/i.test(ua) || (uaData && uaData.mobile)) device = 'Mobile';

  let os = NA;
  if (/Android/i.test(ua) || (uaData && uaData.platform === 'Android')) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua) || isIPad) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  const pick = (re, name) => {
    const m = ua.match(re);
    return m ? name + ' ' + m[1] : null;
  };
  const browser =
    pick(/Edg\/([\d.]+)/, 'Edge') ||
    pick(/OPR\/([\d.]+)/, 'Opera') ||
    pick(/Firefox\/([\d.]+)/, 'Firefox') ||
    pick(/Chrome\/([\d.]+)/, 'Chrome') ||
    pick(/Version\/([\d.]+).*Safari/, 'Safari') ||
    NA;

  const readOrientation = () => {
    const t = screen.orientation && screen.orientation.type;
    if (t) return t.startsWith('landscape') ? 'Landscape' : 'Portrait';
    return window.innerWidth > window.innerHeight ? 'Landscape' : 'Portrait';
  };
  const refresh = () => {
    $('di-viewport').textContent = window.innerWidth + ' × ' + window.innerHeight;
    $('di-orientation').textContent = readOrientation();
  };

  $('di-device').textContent = device;
  $('di-os').textContent = os;
  $('di-browser').textContent = browser;
  $('di-screen').textContent = screen.width + ' × ' + screen.height;
  $('di-lang').textContent = navigator.language || NA;
  $('di-tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || NA;
  refresh();

  if (os !== 'Android') {
    $('di-android-row').hidden = true;
  } else if (uaData && uaData.getHighEntropyValues) {
    uaData.getHighEntropyValues(['platformVersion'])
      .then(v => { if (v.platformVersion) $('di-android').textContent = v.platformVersion.split('.')[0]; })
      .catch(() => {});
  }
  addEventListener('resize', refresh);
})();


// ---- Supabase (optional direct upload) ----
// Fill these in to enable uploads. Leave empty to keep everything local.
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';
const SUPABASE_BUCKET = 'fingerprints';
const sb = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;


// ---- Fingerprint Story ----
const FINGERS = [
  { id: 'index',  name: 'Index finger',  theme: 'The Beginning',
    quote: 'Every story starts with a first step. Maybe this one started before either of you noticed.' },
  { id: 'middle', name: 'Middle finger', theme: 'The Bond',
    quote: "Some connections don't need constant words. They simply become part of the rhythm of everyday life." },
  { id: 'ring',   name: 'Ring finger',   theme: 'The Promise 💍',
    quote: 'A reminder that the most meaningful promises are often written through actions, not words.' },
  { id: 'little', name: 'Little finger', theme: 'The Secret',
    quote: 'The smallest fingerprint keeps the quietest story — the little things only two people understand.' },
];

const ROI = 0.62;            // ROI side as fraction of shorter frame side
const INTERVAL = 300;         // ms between quality checks
const READY_STREAK = 3;       // consecutive READY frames before auto capture
const STABILITY_MIN = 40;     // 0-100, frames must be reasonably steady
const MAX_SIDE = 1600;        // cap on saved PNG side length

const $ = id => document.getElementById(id);
const stageEl = document.querySelector('.stage');
const video = $('video'), roiEl = $('roi'), focusEl = $('focus');
const statusEl = $('status'), metricsEl = $('metrics'), hintEl = $('hint');
const stepLabel = $('stepLabel');
const successEl = $('success'), thumb = $('thumb');
const successTitle = $('successTitle'), themeEl = $('theme'), quoteEl = $('quote');
const captureUI = $('captureUI'), finalEl = $('final'), fpList = $('fpList'), finalNote = $('finalNote');
const beginBtn = $('begin'), continueBtn = $('continue'), torchBtn = $('torch');

// Full-resolution ROI crop buffer
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

// Downsampled buffer for quality metrics
const qN = 128;
const qCanvas = document.createElement('canvas');
qCanvas.width = qCanvas.height = qN;
const qCtx = qCanvas.getContext('2d', { willReadFrequently: true });

// Tiny buffer for stability
const sN = 32;
const sCanvas = document.createElement('canvas');
sCanvas.width = sCanvas.height = sN;
const sCtx = sCanvas.getContext('2d');

let stream = null;
let step = -1;
let running = false;
let readyStreak = 0;
let lastGray = null;
let torchOn = false;
let lowLightFrames = 0;
const captured = {};


// ---- Geometry ----
function roiRect() {
  const w = video.videoWidth || 1, h = video.videoHeight || 1;
  const side = Math.round(Math.min(w, h) * ROI);
  return { x: (w - side) >> 1, y: (h - side) >> 1, side };
}

function placeRoi() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const cw = video.clientWidth, ch = video.clientHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  const r = roiRect();
  roiEl.style.left = (ox + r.x * scale) + 'px';
  roiEl.style.top  = (oy + r.y * scale) + 'px';
  roiEl.style.width  = (r.side * scale) + 'px';
  roiEl.style.height = (r.side * scale) + 'px';
}

// Draw the ROI crop at native resolution (capped at MAX_SIDE).
function crop() {
  const r = roiRect();
  const side = Math.min(r.side, MAX_SIDE);
  canvas.width = canvas.height = side;
  ctx.drawImage(video, r.x, r.y, r.side, r.side, 0, 0, side, side);
}


// ---- Quality analysis (client-side, lightweight) ----
function stability() {
  sCtx.drawImage(canvas, 0, 0, sN, sN);
  const d = sCtx.getImageData(0, 0, sN, sN).data;
  const g = new Float32Array(sN * sN);
  for (let i = 0; i < g.length; i++) g[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
  let diff = 0;
  if (lastGray) {
    for (let i = 0; i < g.length; i++) diff += Math.abs(g[i] - lastGray[i]);
    diff /= g.length;
  }
  lastGray = g;
  return Math.max(0, Math.min(100, Math.round(100 - diff * 3)));
}

function analyzeROI() {
  qCtx.drawImage(canvas, 0, 0, qN, qN);
  const d = qCtx.getImageData(0, 0, qN, qN).data;

  const gray = new Float32Array(qN * qN);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
    gray[i] = g; sum += g;
  }
  const mean = sum / gray.length;
  let vsum = 0;
  for (let i = 0; i < gray.length; i++) { const dv = gray[i] - mean; vsum += dv*dv; }
  const std = Math.sqrt(vsum / gray.length);

  let lapSum = 0, lapSqSum = 0, edges = 0;
  for (let y = 1; y < qN - 1; y++) {
    for (let x = 1; x < qN - 1; x++) {
      const i = y*qN + x;
      const lap = 4*gray[i] - gray[i-1] - gray[i+1] - gray[i-qN] - gray[i+qN];
      lapSum += lap; lapSqSum += lap*lap;
      const gx = gray[i+1] - gray[i-1];
      const gy = gray[i+qN] - gray[i-qN];
      if (gx*gx + gy*gy > 625) edges++;
    }
  }
  const n = (qN - 2) * (qN - 2);
  const lapVar = lapSqSum / n - (lapSum / n) ** 2;

  return {
    brightness: Math.round(mean / 255 * 100),
    contrast:   Math.min(100, Math.round(std * 0.9)),
    sharpness:  Math.min(100, Math.round(Math.sqrt(Math.max(0, lapVar)) * 1.2)),
    coverage:   Math.min(100, Math.round(edges / n * 400)),
  };
}

function decide(a, stab) {
  // Only reject when the image is genuinely useless.
  if (a.brightness < 6 || a.brightness > 98) return { score: 0, status: 'POOR' };
  if (a.coverage < 3) return { score: 0, status: 'POOR' };

  const brightnessScore = Math.max(0, 100 - Math.abs(a.brightness - 55) * 2);
  const s = a.coverage   * 0.35
          + a.sharpness  * 0.25
          + a.contrast   * 0.15
          + brightnessScore * 0.15
          + stab         * 0.10;

  const status = s >= 42 ? 'READY' : s >= 26 ? 'GOOD' : s >= 12 ? 'FAIR' : 'POOR';
  return { score: Math.round(s * 10) / 10, status };
}

function renderMetrics(a, stab, score) {
  metricsEl.textContent =
    'Sharpness:  ' + a.sharpness + '\n' +
    'Contrast:   ' + a.contrast + '\n' +
    'Brightness: ' + a.brightness + '\n' +
    'Coverage:   ' + a.coverage + '\n' +
    'Stability:  ' + stab + '\n' +
    'Score:      ' + score;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
  stageEl.className = 'stage ' + cls;
}


// ---- Tap-to-focus ----
function focusIndicator(x, y, supported) {
  const rect = stageEl.getBoundingClientRect();
  focusEl.style.left = (x - rect.left) + 'px';
  focusEl.style.top  = (y - rect.top) + 'px';
  focusEl.classList.toggle('unsupported', !supported);
  focusEl.hidden = false;
  focusEl.style.animation = 'none';
  void focusEl.offsetWidth;
  focusEl.style.animation = '';
  clearTimeout(focusEl._t);
  focusEl._t = setTimeout(() => { focusEl.hidden = true; }, 700);
}

async function tapToFocus(x, y) {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() || {};
  if (!track || !caps.focusMode || !caps.focusMode.includes('single-shot')) {
    focusIndicator(x, y, false);
    return;
  }
  const rect = video.getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  const fy = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  try {
    await track.applyConstraints({
      advanced: [{ focusMode: 'single-shot', points: [{ x: fx, y: fy }] }],
    });
    focusIndicator(x, y, true);
  } catch {
    focusIndicator(x, y, false);
  }
}


// ---- Torch ----
async function setupTrack() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};

  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }

  if (!caps.torch) {
    torchBtn.disabled = true;
    torchBtn.textContent = '🔦 Flash not supported';
  } else {
    torchBtn.disabled = false;
    torchBtn.textContent = torchOn ? '🔦 Flash: ON' : '🔦 Flash: OFF';
    torchBtn.classList.toggle('on', torchOn);
  }
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  if (!caps.torch) return;

  const next = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    torchOn = next;
    torchBtn.textContent = next ? '🔦 Flash: ON' : '🔦 Flash: OFF';
    torchBtn.classList.toggle('on', next);
    if (next) { hintEl.textContent = ''; lowLightFrames = 0; }
  } catch { /* ignored */ }
}

function updateHint(brightness) {
  if (torchOn) { hintEl.textContent = ''; lowLightFrames = 0; return; }
  lowLightFrames = brightness < 30 ? lowLightFrames + 1 : Math.max(0, lowLightFrames - 1);
  hintEl.textContent = lowLightFrames >= 4 ? 'Low light — try turning on Flash' : '';
}


// ---- Capture loop ----
async function loop() {
  if (!running) return;

  crop();
  const stab = stability();
  const a = analyzeROI();
  const { score, status } = decide(a, stab);

  renderMetrics(a, stab, score);
  setStatus(status, status.toLowerCase());
  updateHint(a.brightness);

  if (status === 'READY') {
    readyStreak++;
    if (readyStreak >= READY_STREAK) {
      running = false;
      await captureCurrent();
      return;
    }
  } else {
    readyStreak = 0;
  }

  if (running) setTimeout(loop, INTERVAL);
}

async function captureCurrent() {
  crop();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const url = URL.createObjectURL(blob);
  const finger = FINGERS[step];
  captured[finger.id] = url;

  uploadToSupabase(blob, finger.id).catch(() => {});
  showSuccess(finger, url);
}

async function uploadToSupabase(blob, name) {
  if (!sb) return;
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(`${name}.png`, blob, {
    contentType: 'image/png',
    upsert: true,
  });
  if (error) throw error;
}

function showSuccess(finger, url) {
  thumb.src = url;
  successTitle.textContent = finger.name + ' captured';
  themeEl.textContent = finger.theme;
  quoteEl.textContent = finger.quote;
  successEl.hidden = false;
  captureUI.hidden = true;
  continueBtn.textContent = step < FINGERS.length - 1 ? 'Continue' : 'See the ending';
}

function startFinger(i) {
  step = i;
  stepLabel.textContent = 'Step ' + (i + 1) + ' of 4 — ' + FINGERS[i].name;
  successEl.hidden = true;
  captureUI.hidden = false;
  hintEl.textContent = '';
  readyStreak = 0;
  lowLightFrames = 0;
  lastGray = null;
  setStatus('Position your finger', 'poor');
  running = true;
  loop();
}

function finish() {
  running = false;
  captureUI.hidden = true;
  successEl.hidden = true;
  finalEl.hidden = false;
  fpList.innerHTML = '';
  for (const f of FINGERS) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = captured[f.id];
    const span = document.createElement('span');
    span.textContent = f.name.split(' ')[0] + ' ✓';
    li.append(img, span);
    fpList.appendChild(li);
  }
  finalNote.textContent = sb ? `Uploaded to Supabase · ${SUPABASE_BUCKET}` : 'Captured locally';
  if (stream) stream.getTracks().forEach(t => t.stop());
}

async function begin() {
  beginBtn.hidden = true;
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await setupTrack();
    } catch (e) {
      setStatus('Camera unavailable', 'poor');
      beginBtn.hidden = false;
      return;
    }
  }
  roiEl.hidden = false;
  placeRoi();
  startFinger(0);
}

function nextFinger() {
  if (step < FINGERS.length - 1) startFinger(step + 1);
  else finish();
}

beginBtn.onclick = begin;
continueBtn.onclick = nextFinger;
torchBtn.onclick = toggleTorch;
video.addEventListener('click', e => tapToFocus(e.clientX, e.clientY));
video.addEventListener('loadedmetadata', placeRoi);
window.addEventListener('resize', placeRoi);