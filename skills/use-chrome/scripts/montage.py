"""Tile burst screenshots of a CAPTCHA challenge into one image, so one look shows the motion.

Usage: python3 montage.py <dir> [prefix=b] [crop=20,140,500,470]
Reads <dir>/<prefix>0.png, <prefix>1.png, ... and writes <dir>/montage.png (4 columns, half size).
"""
import sys
from pathlib import Path

from PIL import Image

folder = Path(sys.argv[1])
prefix = sys.argv[2] if len(sys.argv) > 2 else "b"
crop = tuple(int(v) for v in (sys.argv[3] if len(sys.argv) > 3 else "20,140,500,470").split(","))
frames = []
while (folder / f"{prefix}{len(frames)}.png").exists():
    frames.append(Image.open(folder / f"{prefix}{len(frames)}.png").crop(crop))
if not frames:
    sys.exit(f"no {prefix}0.png in {folder}")
w, h = frames[0].size
cols, rows = 4, (len(frames) + 3) // 4
sheet = Image.new("RGB", (w * cols, h * rows))
for i, frame in enumerate(frames):
    sheet.paste(frame, ((i % cols) * w, (i // cols) * h))
sheet.resize((w * cols // 2, h * rows // 2)).save(folder / "montage.png")
print(folder / "montage.png", f"{len(frames)} frames")
