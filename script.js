const video = document.getElementById('video');
const shot = document.getElementById('shot');
const roi = document.getElementById('roi');
const statusEl = document.getElementById('status');
const metricsEl = document.getElementById('metrics');
const note = document.getElementById('note');
const startBtn = document.getElementById('start');
const retakeBtn = document.getElementById('retake');
const saveBtn = document.getElementById('save');

const ROI = 0.6;            // ROI side as a fraction of the smaller frame side
const INTERVAL = 500;       // ms between quality analyses
const READY_STREAK = 2;     // consecutive READY results before auto capture
const JPEG_QUALITY = 0.85;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

let stream = null;
let running = false;
let readyStreak = 0;
let capturedBlob = null;

metricsEl.style.whiteSpace = 'pre-line';

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

function roiRect(w, h) {
  const side = Math.round(Math.min(w, h) * ROI);
  return { x: (w - side) >> 1, y: (h - side) >> 1, side: side };
}

function placeRoi() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  const r = roiRect(w, h);
  const dw = video.clientWidth / w;
  const dh = video.clientHeight / h;
  roi.style.left = (video.offsetLeft + r.x * dw) + 'px';
  roi.style.top = (video.offsetTop + r.y * dh) + 'px';
  roi.style.width = (r.side * dw) + 'px';
  roi.style.height = (r.side * dh) + 'px';
}

// Draws the current ROI region of the video frame into the working canvas.
function crop() {
  const r = roiRect(video.videoWidth, video.videoHeight);
  canvas.width = r.side;
  canvas.height = r.side;
  ctx.drawImage(video, r.x, r.y, r.side, r.side, 0, 0, r.side, r.side);
}

function showMetrics(m) {
  metricsEl.textContent =
    'Sharpness:        ' + m.sharpness + '\n' +
    'Brightness:       ' + m.brightness + '\n' +
    'Contrast:         ' + m.contrast + '\n' +
    'Blur:             ' + m.blur + '\n' +
    'Exposure:         ' + m.exposure + '\n' +
    'Coverage:         ' + m.coverage + '%\n' +
    'Position:         ' + m.position + '\n' +
    'Ridge Visibility: ' + m.ridge + '\n' +
    'Overall Quality:  ' + m.overall;
}

function handle(m) {
  showMetrics(m);
  setStatus(m.status, m.status.toLowerCase());

  if (m.status === 'READY') {
    readyStreak++;
    if (readyStreak >= READY_STREAK) capture();
  } else {
    readyStreak = 0;
  }
}

async function loop() {
  if (!running) return;

  try {
    crop();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    const form = new FormData();
    form.append('frame', blob, 'frame.jpg');
    const res = await fetch('/api/analyze', { method: 'POST', body: form });
    if (res.ok) handle(await res.json());
  } catch (e) {
    // transient frame or network error: skip this iteration
  }

  if (running) setTimeout(loop, INTERVAL);
}

function capture() {
  running = false;
  readyStreak = 0;

  crop();
  canvas.toBlob(blob => {
    capturedBlob = blob;
    shot.src = URL.createObjectURL(blob);
  }, 'image/png');

  video.hidden = true;
  roi.hidden = true;
  shot.hidden = false;
  startBtn.hidden = true;
  retakeBtn.hidden = false;
  saveBtn.hidden = false;
  setStatus('CAPTURED', 'ready');
  note.textContent = 'Review the captured fingerprint, then save or retake.';
}

async function start() {
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (e) {
      setStatus('CAMERA UNAVAILABLE', 'poor');
      note.textContent = 'Camera access was blocked. Open the page over HTTPS and allow camera permission.';
      return;
    }
    video.srcObject = stream;
    await video.play();
  }

  capturedBlob = null;
  readyStreak = 0;
  video.hidden = false;
  shot.hidden = true;
  roi.hidden = false;
  startBtn.hidden = true;
  retakeBtn.hidden = true;
  saveBtn.hidden = true;
  note.textContent = 'Place your finger inside the square. Capture happens automatically when the image is ready.';

  placeRoi();
  running = true;
  loop();
}

async function save() {
  if (!capturedBlob) return;

  const form = new FormData();
  form.append('image', capturedBlob, 'fingerprint.png');

  saveBtn.disabled = true;
  try {
    const res = await fetch('/api/save', { method: 'POST', body: form });
    const data = await res.json();
    note.textContent = 'Saved locally: ' + data.path;
  } catch (e) {
    note.textContent = 'Could not reach the local server.';
  }
  saveBtn.disabled = false;
}

video.addEventListener('loadedmetadata', placeRoi);
addEventListener('resize', placeRoi);
startBtn.addEventListener('click', start);
retakeBtn.addEventListener('click', start);
saveBtn.addEventListener('click', save);