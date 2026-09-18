from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CAPTURES = ROOT / "captures"
CAPTURES.mkdir(exist_ok=True)

ALLOWED = {"index", "middle", "ring", "little"}

app = FastAPI()


def analyze(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (256, 256))

    sharpness = int(np.clip(cv2.Laplacian(gray, cv2.CV_64F).var() / 5, 0, 100))
    brightness = int(gray.mean() / 255 * 100)
    contrast = int(np.clip(gray.std() / 0.8, 0, 100))
    blur = max(0, 100 - sharpness)

    gabor = cv2.getGaborKernel((15, 15), 4.0, np.pi / 4, 10.0, 0.5, 0)
    ridge_map = cv2.filter2D(gray, cv2.CV_32F, gabor)
    ridge = int(np.clip(ridge_map.std() * 1.2, 0, 100))

    edges = cv2.Canny(gray, 40, 120)
    coverage = int(np.clip(edges.mean() * 6, 0, 100))

    ys, xs = np.nonzero(edges)
    if len(xs) > 50:
        dev = (abs(xs.mean() - 128) + abs(ys.mean() - 128)) / 256
        position = int(np.clip(100 - dev * 250, 0, 100))
    else:
        position = 0

    return dict(sharpness=sharpness, brightness=brightness, contrast=contrast,
                blur=blur, ridge=ridge, coverage=coverage, position=position)


def decide(m):
    ok = (m["sharpness"] >= 45 and 30 <= m["brightness"] <= 85 and
          m["contrast"] >= 25 and m["ridge"] >= 35 and
          m["coverage"] >= 15 and m["position"] >= 55)
    if ok:
        return "READY"
    score = (m["sharpness"] * 0.3 + m["contrast"] * 0.2 + m["ridge"] * 0.3 +
             m["coverage"] * 0.1 + m["position"] * 0.1)
    return "GOOD" if score >= 60 else "FAIR" if score >= 40 else "POOR"


@app.post("/api/analyze")
async def api_analyze(frame: UploadFile = File(...)):
    data = np.frombuffer(await frame.read(), np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "bad frame")
    m = analyze(img)
    m["status"] = decide(m)
    return m


@app.post("/api/save")
async def api_save(image: UploadFile = File(...), name: str = Form(...)):
    if name not in ALLOWED:
        raise HTTPException(400, "invalid name")
    data = await image.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "bad image")
    path = CAPTURES / f"{name}.png"
    cv2.imwrite(str(path), img)
    return {"path": str(path)}


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")