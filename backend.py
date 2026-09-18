import cv2
import numpy as np
import argparse
from pathlib import Path


def preprocess(path, size=(640, 640)):
    img = cv2.imread(str(path))
    if img is None:
        raise FileNotFoundError(f"Could not read image: {path}")

    img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Improve local contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    return img, gray


def detect_fingerprint_roi(gray):
    """
    Detect high-texture region that likely contains a fingerprint.
    Returns list of boxes: [(x, y, w, h), ...]
    """
    # Gradient magnitude highlights ridges/texture
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)

    mag = cv2.magnitude(gx, gy)
    mag = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)

    # Smooth texture map
    mag = cv2.GaussianBlur(mag, (31, 31), 0)

    # Otsu threshold
    _, th = cv2.threshold(mag, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Morphology to join fingerprint ridges into one region
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=2)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    h, w = gray.shape
    boxes = []

    for c in contours:
        area = cv2.contourArea(c)

        # Ignore tiny regions
        if area < 0.01 * w * h:
            continue

        x, y, bw, bh = cv2.boundingRect(c)

        # Fingerprint ROI is usually not extremely thin
        aspect = bw / float(bh)
        if 0.3 < aspect < 3.0:
            boxes.append((x, y, bw, bh))

    # Return largest region first
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    return boxes[:1], th


def draw_boxes(img, boxes):
    out = img.copy()
    for i, (x, y, w, h) in enumerate(boxes):
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 255, 0), 2)
        cv2.putText(
            out,
            f"Fingerprint {i + 1}",
            (x, y - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 0),
            2,
        )
    return out


def match_fingerprints(path1, path2, max_features=1000):
    """
    Quick baseline matching using ORB.
    Returns score from 0 to 1.
    """
    img1 = cv2.imread(str(path1), cv2.IMREAD_GRAYSCALE)
    img2 = cv2.imread(str(path2), cv2.IMREAD_GRAYSCALE)

    if img1 is None or img2 is None:
        raise FileNotFoundError("One of the fingerprint images was not found.")

    img1 = cv2.resize(img1, (320, 320))
    img2 = cv2.resize(img2, (320, 320))

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    img1 = clahe.apply(img1)
    img2 = clahe.apply(img2)

    orb = cv2.ORB_create(nfeatures=max_features)
    kp1, des1 = orb.detectAndCompute(img1, None)
    kp2, des2 = orb.detectAndCompute(img2, None)

    if des1 is None or des2 is None:
        return 0.0, []

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = sorted(bf.match(des1, des2), key=lambda m: m.distance)

    # Distance threshold can be tuned
    good = [m for m in matches if m.distance < 50]

    score = len(good) / max(1, min(len(kp1), len(kp2)))
    return score, good


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", help="Input fingerprint image")
    parser.add_argument("--out", default="output.jpg", help="Output image path")
    parser.add_argument("--match", help="Second fingerprint image for matching")
    args = parser.parse_args()

    img, gray = preprocess(args.image)
    boxes, mask = detect_fingerprint_roi(gray)

    result = draw_boxes(img, boxes)

    cv2.imwrite(args.out, result)
    cv2.imwrite("mask.jpg", mask)

    print("Detected boxes:", boxes)

    if args.match:
        score, good = match_fingerprints(args.image, args.match)
        print(f"Match score: {score:.3f}")
        print(f"Good matches: {len(good)}")


if __name__ == "__main__":
    main()