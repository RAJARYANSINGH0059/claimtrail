"""Regenerate samples/*.png|pdf: synthetic 'scanned' documents rendered from the fixture text (needs Pillow)."""
import json, random, subprocess, pathlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "samples"; out.mkdir(exist_ok=True)
S = json.loads(subprocess.check_output(["node", "-e", "console.log(JSON.stringify(require('./src/fixtures').SAMPLES))"], cwd=root))
text = {s["id"]: s["pages"][0] for s in S}
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def render(t, size=30, w=1500):
    f = ImageFont.truetype(FONT, size)
    lines = t.split("\n"); h = 80 + len(lines) * int(size * 1.6)
    im = Image.new("L", (w, h), 255); d = ImageDraw.Draw(im)
    for i, l in enumerate(lines): d.text((50, 40 + i * int(size * 1.6)), l, font=f, fill=20)
    return im

clean = render(text["S-PHARM"])
clean.save(out / "pharmacy_bill_scan_corrected.png")                       # high-confidence image
render(text["S-LAB"]).convert("RGB").save(out / "lab_report_scan.pdf")     # image-only PDF -> rasterise + OCR

random.seed(7)  # deterministic degraded scan
bad = render(text["S-PHARM"], size=22, w=900).filter(ImageFilter.GaussianBlur(3.2)).rotate(2.5, fillcolor=255)
px = bad.load()
for x in range(bad.width):
    for y in range(bad.height):
        px[x, y] = max(0, min(255, int(px[x, y] * 0.55 + 110 + random.gauss(0, 38))))
bad.save(out / "poor_scan_unreadable.png")
print("wrote", sorted(p.name for p in out.iterdir()))
