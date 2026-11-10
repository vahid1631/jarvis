# -*- coding: utf-8 -*-
"""ساخت آیکون جارویس (راکتور آبی) — 192 و 512 پیکسل"""

from PIL import Image, ImageDraw, ImageFilter
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT_DIR, exist_ok=True)

CYAN = (53, 224, 255, 255)
CYAN_SOFT = (53, 224, 255, 90)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (2, 6, 16, 255))
    d = ImageDraw.Draw(img)
    s = size / 512  # مقیاس نسبت به ۵۱۲

    # پس‌زمینه شعاعی (تقریبی با دایره‌های هم‌مرکز کم‌رنگ)
    for r, alpha in [(256, 26), (200, 36), (140, 46), (80, 56)]:
        rr = int(r * s)
        d.ellipse([256 * s - rr, 256 * s - rr, 256 * s + rr, 256 * s + rr],
                  fill=(8, 28, 50, alpha))

    # هاله نور
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([256 * s - 190 * s, 256 * s - 190 * s, 256 * s + 190 * s, 256 * s + 190 * s],
               fill=(30, 160, 220, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(30 * s))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)

    # حلقه‌های بیرونی
    def ring(radius, width, color):
        rr = int(radius * s)
        wd = max(2, int(width * s))
        d.ellipse([256 * s - rr, 256 * s - rr, 256 * s + rr, 256 * s + rr],
                  outline=color, width=wd)

    ring(226, 10, CYAN_SOFT)
    ring(196, 22, CYAN)
    ring(150, 4, CYAN_SOFT)

    # قطاعات داخلی (مثل راکتور)
    import math
    cx = cy = 256 * s
    R1, R2 = 170 * s, 130 * s
    for i in range(8):
        a0 = i * (math.pi / 4) + 0.14
        a1 = (i + 1) * (math.pi / 4) - 0.14
        d.pieslice([cx - R2, cy - R2, cx + R2, cy + R2], math.degrees(a0), math.degrees(a1),
                   outline=CYAN_SOFT, width=max(2, int(14 * s)))

    # هسته مرکزی درخشان
    core = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    r_core = int(110 * s)
    cd.ellipse([cx - r_core, cy - r_core, cx + r_core, cy + r_core],
               fill=(120, 235, 255, 200))
    core = core.filter(ImageFilter.GaussianBlur(18 * s))
    img.alpha_composite(core)

    d = ImageDraw.Draw(img)
    r_white = int(74 * s)
    d.ellipse([cx - r_white, cy - r_white, cx + r_white, cy + r_white],
              fill=(225, 250, 255, 255))

    return img


for px in (192, 512):
    icon = make_icon(px)
    path = os.path.join(OUT_DIR, f"icon-{px}.png")
    icon.save(path)
    print("saved:", path)
