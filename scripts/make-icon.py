#!/usr/bin/env python3
"""
Clono app icon master renderer.

Concept: a single immunoglobulin (antibody) Y silhouette -- two Fab arms
tipped with antigen-binding paratope nodes over an Fc stem -- in white on a
deep azure->navy macOS squircle with a domed highlight.

Renders a 1024x1024 RGBA master PNG.
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

N = 1024          # final master size
S = 4             # supersample factor
C = N * S         # working canvas

# ---------------------------------------------------------------- geometry --
# Apple macOS Big Sur+ icon grid: 824x824 shape inside a 1024 canvas.
SQ_HALF = 412.0   # half-extent of the squircle, in 1024-space
SQ_N = 5.0        # superellipse exponent ~= Apple continuous-corner squircle
CEN = N / 2.0

# Antibody glyph, in 1024-space.
# Each Fab arm is two segments meeting at an elbow: the hinge throws the arm
# out wide, then it sweeps back up to the paratope. That articulation is what
# keeps the mark an immunoglobulin rather than a letterform Y.
STROKE = 90.0     # limb thickness
CAP = STROKE / 2.0
TIP_R = 60.0      # paratope node radius at the Fab tips
TY = 280.0        # y of the Fab paratopes
EY = 417.0        # y of the Fab elbows
HY = 544.0        # y of the hinge
BY = 760.0        # y of the Fc stem base
TDX = 218.0       # half-spread at the paratopes
EDX = 164.0       # half-spread at the elbows

LTIP = (CEN - TDX, TY)
RTIP = (CEN + TDX, TY)
LELB = (CEN - EDX, EY)
RELB = (CEN + EDX, EY)
HINGE = (CEN, HY)
BASE = (CEN, BY)

# ------------------------------------------------------------------ colour --
# light -> dark along a top-left to bottom-right diagonal
STOPS = [
    (0.00, (112, 166, 255)),   # bright azure
    (0.40, (56,  98, 228)),    # true blue
    (0.74, (36,  54, 166)),    # indigo
    (1.00, (20,  25,  88)),    # deep navy-indigo
]


def s(v):
    """1024-space scalar -> supersampled canvas space."""
    return v * S


def pt(p):
    return (p[0] * S, p[1] * S)


def superellipse_mask():
    """Antialiased mask of the macOS squircle at canvas resolution."""
    a = s(SQ_HALF)
    c = C / 2.0
    y, x = np.mgrid[0:C, 0:C].astype(np.float64)
    x = (x + 0.5 - c) / a
    y = (y + 0.5 - c) / a
    d = np.abs(x) ** SQ_N + np.abs(y) ** SQ_N
    # binary at this resolution; the 4x downsample supplies the antialiasing
    return Image.fromarray(((d <= 1.0) * 255).astype(np.uint8), "L")


def gradient():
    """Diagonal multi-stop gradient with a soft dome highlight."""
    y, x = np.mgrid[0:C, 0:C].astype(np.float64)
    t = (y / C) * 0.78 + (x / C) * 0.22
    t = np.clip(t, 0.0, 1.0)

    out = np.zeros((C, C, 3), dtype=np.float64)
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        seg = (t >= t0) & (t < t1) if t1 < 1.0 else (t >= t0) & (t <= t1)
        k = (t - t0) / (t1 - t0)
        k = np.clip(k, 0.0, 1.0)
        k = k * k * (3 - 2 * k)
        for ch in range(3):
            out[..., ch] = np.where(seg, c0[ch] + (c1[ch] - c0[ch]) * k, out[..., ch])

    # dome: broad soft white glow, upper-centre
    gx, gy = C * 0.5, C * 0.24
    r = np.sqrt((x - gx) ** 2 + (y - gy) ** 2) / (C * 0.62)
    glow = np.clip(1.0 - r, 0.0, 1.0) ** 2.3 * 0.20
    out += glow[..., None] * (255.0 - out)

    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def glyph_mask():
    """Antibody Y as a single filled alpha mask."""
    m = Image.new("L", (C, C), 0)
    d = ImageDraw.Draw(m)
    w = s(STROKE)

    for a, b in ((LTIP, LELB), (LELB, HINGE),
                 (RTIP, RELB), (RELB, HINGE),
                 (HINGE, BASE)):
        d.line([pt(a), pt(b)], fill=255, width=int(round(w)))

    # round every junction and terminus
    for p, rr in ((HINGE, CAP), (BASE, CAP), (LELB, CAP), (RELB, CAP),
                  (LTIP, TIP_R), (RTIP, TIP_R)):
        cx, cy = pt(p)
        r = s(rr)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)

    return m


def rim_light(sq):
    """Glassy inner edge: bright along the top, faint bounce at the bottom."""
    inner = sq.filter(ImageFilter.MinFilter(3))
    for _ in range(6):
        inner = inner.filter(ImageFilter.MinFilter(9))
    ring = Image.fromarray(
        np.clip(np.asarray(sq, np.int16) - np.asarray(inner, np.int16), 0, 255).astype(np.uint8),
        "L",
    ).filter(ImageFilter.GaussianBlur(s(1.5)))

    y = np.mgrid[0:C, 0:C][0].astype(np.float64) / C
    top = np.clip(1.0 - y / 0.42, 0.0, 1.0) ** 1.6 * 0.62
    bot = np.clip((y - 0.72) / 0.28, 0.0, 1.0) ** 1.8 * 0.20
    prof = np.clip(top + bot, 0.0, 1.0)

    alpha = (np.asarray(ring, np.float64) / 255.0) * prof
    layer = Image.new("RGB", (C, C), (255, 255, 255))
    return layer, Image.fromarray((alpha * 255).astype(np.uint8), "L")


def build():
    sq = superellipse_mask()
    base = gradient()

    # glassy rim, clipped to the shape
    rim, rim_a = rim_light(sq)
    base = Image.composite(rim, base, rim_a)

    gm = glyph_mask()

    # soft contact shadow under the glyph, clipped to the shape
    sh = gm.filter(ImageFilter.GaussianBlur(s(20)))
    sh = sh.transform(
        (C, C), Image.AFFINE, (1, 0, 0, 0, 1, -s(14)), resample=Image.BILINEAR
    )
    sh_a = Image.fromarray(
        (np.asarray(sh, np.float64) / 255.0 * 0.34 * (np.asarray(sq, np.float64) / 255.0)
         * 255).astype(np.uint8), "L"
    )
    base = Image.composite(Image.new("RGB", (C, C), (6, 10, 44)), base, sh_a)

    # the glyph: near-white, cooling very slightly toward the base
    y = np.mgrid[0:C, 0:C][0].astype(np.float64) / C
    k = np.clip((y - 0.28) / 0.55, 0.0, 1.0)
    gcol = np.zeros((C, C, 3), np.float64)
    for ch, (a, b) in enumerate(zip((255, 255, 255), (226, 236, 255))):
        gcol[..., ch] = a + (b - a) * k
    base = Image.composite(
        Image.fromarray(gcol.astype(np.uint8), "RGB"), base, gm
    )

    out = Image.new("RGBA", (C, C), (0, 0, 0, 0))
    out.paste(base, (0, 0), sq)
    return out.resize((N, N), Image.LANCZOS)


if __name__ == "__main__":
    import sys
    dest = sys.argv[1] if len(sys.argv) > 1 else "icon-source.png"
    build().save(dest)
    print("wrote", dest)
