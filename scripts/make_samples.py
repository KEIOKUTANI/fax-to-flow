#!/usr/bin/env python3
"""Generate the three sample FAX order sheets used by the demo.

Pure PIL. Each image imitates a received fax: grayscale, slightly rotated,
speckle noise, scan streaks, a fax-machine header stamp and a hand-filled
order table. Run:  python3 scripts/make_samples.py
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples")
W, H = 1240, 1754

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]
FONT_PATH = next(p for p in FONT_CANDIDATES if os.path.exists(p))


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def printed(draw, xy, text, size, fill=0):
    draw.text(xy, text, font=font(size), fill=fill)


def handwrite(img, xy, text, size, rng, ink=25, slant=0.0, jitter=1.0):
    """Paste text one glyph at a time with jitter so it looks hand-written."""
    x, y = xy
    for ch in text:
        if ch == " ":
            x += size * 0.45
            continue
        s = int(size * rng.uniform(0.92, 1.08))
        f = font(s)
        box = f.getbbox(ch)
        gw, gh = box[2] + 8, box[3] + 8
        glyph = Image.new("L", (gw + 10, gh + 10), 0)
        gd = ImageDraw.Draw(glyph)
        gd.text((5, 5), ch, font=f, fill=255, stroke_width=1, stroke_fill=255)
        glyph = glyph.rotate(rng.uniform(-6, 6) * jitter + slant, resample=Image.BICUBIC, expand=True)
        dy = rng.uniform(-3, 3) * jitter
        img.paste(Image.new("L", glyph.size, ink), (int(x), int(y + dy)), glyph)
        adv = f.getlength(ch)
        x += adv * rng.uniform(0.94, 1.06) + 1
    return x


def wobbly_line(draw, p0, p1, rng, width=3, fill=20, amp=1.6):
    (x0, y0), (x1, y1) = p0, p1
    n = max(2, int(math.hypot(x1 - x0, y1 - y0) / 40))
    pts = []
    for i in range(n + 1):
        t = i / n
        px = x0 + (x1 - x0) * t + (rng.uniform(-amp, amp) if 0 < i < n else 0)
        py = y0 + (y1 - y0) * t + (rng.uniform(-amp, amp) if 0 < i < n else 0)
        pts.append((px, py))
    draw.line(pts, fill=fill, width=width, joint="curve")


def fax_header(draw, when, sender_fax, sender_name):
    stamp = f"{when}   FROM: {sender_fax}   {sender_name}        P.001/001"
    printed(draw, (40, 22), stamp, 22, fill=40)
    draw.line([(30, 56), (W - 30, 56)], fill=90, width=1)


def form_frame(img, draw, rng, sender, sender_fax, date_text, attn="大和金物株式会社 御中"):
    printed(draw, (W // 2 - 150, 95), "注　文　書", 64)
    printed(draw, (70, 200), attn, 34)
    printed(draw, (70, 246), "FAX 06-6745-8800", 24, fill=50)
    printed(draw, (760, 200), sender, 28)
    printed(draw, (760, 240), f"FAX {sender_fax}", 22, fill=50)
    printed(draw, (760, 275), "ご担当: ", 22, fill=50)
    printed(draw, (70, 300), "日付", 26)
    handwrite(img, (140, 292), date_text, 34, rng)
    printed(draw, (70, 360), "下記の通り注文いたします。", 26)


def order_table(img, draw, rng, rows, top=420, row_h=96, n_rows=8):
    cols = [70, 150, 560, 850, 1010, 1170]
    headers = ["No", "品　名", "規　格", "数　量", "納　期"]
    bottom = top + row_h * (n_rows + 1)
    for x in cols:
        wobbly_line(draw, (x, top), (x, bottom), rng)
    for r in range(n_rows + 2):
        y = top + r * row_h
        wobbly_line(draw, (cols[0], y), (cols[-1], y), rng)
    for i, h in enumerate(headers):
        printed(draw, (cols[i] + 14, top + 30), h, 30)
    for i in range(n_rows):
        printed(draw, (cols[0] + 22, top + row_h * (i + 1) + 32), str(i + 1), 26, fill=60)
    cells = []
    for i, row in enumerate(rows):
        y = top + row_h * (i + 1) + 22
        cells.append(y)
        for j, val in enumerate(row):
            if val:
                handwrite(img, (cols[j + 1] + 16, y), val, 40, rng)
    return cols, cells, bottom


def remarks_box(draw, top, height=230):
    draw.rectangle([70, top, 1170, top + height], outline=30, width=3)
    printed(draw, (86, top + 12), "備考", 28)


def faxify(img, rng, angle, noise=0.004, streaks=3, blur=0.6):
    img = img.rotate(angle, resample=Image.BICUBIC, fillcolor=255, expand=False)
    px = img.load()
    n = int(W * H * noise)
    for _ in range(n):
        x, y = rng.randrange(W), rng.randrange(H)
        r = rng.choice([0, 0, 0, 1])
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if 0 <= x + dx < W and 0 <= y + dy < H:
                    px[x + dx, y + dy] = rng.randrange(0, 90)
    d = ImageDraw.Draw(img)
    for _ in range(streaks):
        y = rng.randrange(80, H - 40)
        d.line([(0, y), (W, y)], fill=rng.randrange(150, 210), width=rng.choice([1, 2]))
    img = img.filter(ImageFilter.GaussianBlur(blur))
    # crush to fax-like contrast
    img = img.point(lambda v: 0 if v < 110 else (255 if v > 200 else int((v - 110) * 255 / 90)))
    return img


def sample_clean():
    rng = random.Random(11)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    fax_header(d, "2026/10/15 08:12", "06 6781 2345", "HIGASHIOSAKA SEIKO")
    form_frame(img, d, rng, "東大阪精工株式会社 購買課", "06-6781-2345", "10/15")
    handwrite(img, (860, 268), "田中", 30, rng)
    rows = [
        ("六角ボルト", "M8×30", "3箱", "10/17"),
        ("六角ナット", "M8", "2箱", "10/17"),
        ("平ワッシャー", "M8", "2箱", "10/17"),
        ("キャップボルト", "M6×20", "1箱", "10/17"),
    ]
    _, _, bottom = order_table(img, d, rng, rows)
    remarks_box(d, bottom + 40)
    handwrite(img, (110, bottom + 100), "いつもお世話になっております。", 36, rng)
    handwrite(img, (110, bottom + 160), "午前中着でお願いします。", 36, rng)
    return faxify(img, rng, angle=0.7, noise=0.0025, streaks=2)


def sample_messy():
    rng = random.Random(23)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    fax_header(d, "2026/10/15 07:48", "06 6728 9902", "KAWACHI SEISAKUSHO")
    form_frame(img, d, rng, "株式会社 河内製作所 製造部", "06-6728-9902", "10/15")
    handwrite(img, (860, 268), "山本", 30, rng, jitter=1.6)
    rows = [
        ("六ボル", "M10-30", "5", "金曜"),
        ("SUS六角ボルト", "M10×40", "3箱", "金曜"),
        ("ワッシャー", "M10", "", "金曜"),
        ("ステンナット", "M10", "2", "金曜"),
    ]
    cols, cells, bottom = order_table(img, d, rng, rows)
    # crossed-out quantity on row 3: "4" struck through, "6" written beside it
    y = cells[2]
    x4 = cols[3] + 18
    handwrite(img, (x4, y), "4", 42, rng, jitter=1.4)
    # Japanese-style correction: double strike-through (二重線)
    wobbly_line(d, (x4 - 10, y + 22), (x4 + 38, y + 18), rng, width=3, fill=15, amp=1)
    wobbly_line(d, (x4 - 10, y + 32), (x4 + 38, y + 28), rng, width=3, fill=15, amp=1)
    handwrite(img, (x4 + 56, y - 6), "6", 44, rng, jitter=1.4)
    # scribbled check marks / arrows in margin
    wobbly_line(d, (1185, cells[1] + 10), (1210, cells[1] + 40), rng, width=3)
    remarks_box(d, bottom + 40)
    handwrite(img, (110, bottom + 100), "急ぎです！ 金曜朝イチ必着で", 40, rng, slant=-3, jitter=1.6)
    handwrite(img, (110, bottom + 160), "SUSが無ければ連絡ください", 36, rng, slant=-2, jitter=1.6)
    return faxify(img, rng, angle=-1.6, noise=0.006, streaks=5, blur=0.8)


def sample_usual():
    rng = random.Random(37)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    fax_header(d, "2026/10/15 18:31", "072 965 4411", "MORITA KOMUTEN")
    # memo-style sheet instead of a formal form
    printed(d, (70, 100), "FAX送信票", 46)
    d.line([(70, 160), (1170, 160)], fill=30, width=2)
    printed(d, (70, 190), "宛先：", 30)
    handwrite(img, (170, 180), "大和金物さん", 46, rng)
    printed(d, (70, 270), "発信：", 30)
    handwrite(img, (170, 260), "森田工務店 森田", 46, rng)
    printed(d, (760, 270), "TEL/FAX 072-965-4411", 24, fill=50)
    printed(d, (70, 350), "日付：", 30)
    handwrite(img, (170, 340), "10/15", 44, rng)
    d.line([(70, 420), (1170, 420)], fill=30, width=2)
    handwrite(img, (120, 500), "いつもの分、今回は倍で。", 64, rng, jitter=1.2)
    handwrite(img, (120, 600), "現場が2件かさなってます。", 48, rng, jitter=1.2)
    handwrite(img, (120, 720), "あと", 48, rng)
    handwrite(img, (240, 720), "コーススレッド 4.2×51", 48, rng)
    handwrite(img, (820, 720), "2箱 追加", 48, rng)
    wobbly_line(d, (110, 790), (1120, 794), rng, width=2, amp=3)
    handwrite(img, (120, 860), "納品は来週月曜 (10/19) で", 46, rng)
    handwrite(img, (120, 940), "お願いします。", 46, rng)
    handwrite(img, (820, 1080), "よろしく！", 52, rng, slant=-4)
    return faxify(img, rng, angle=1.2, noise=0.0045, streaks=4, blur=0.7)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, fn in [("sample1_clean", sample_clean), ("sample2_messy", sample_messy), ("sample3_usual", sample_usual)]:
        img = fn()
        path = os.path.join(OUT, f"{name}.png")
        img.save(path, optimize=True)
        print(path, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
