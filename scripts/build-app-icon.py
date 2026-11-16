#!/usr/bin/env python3
"""MyHub 앱 아이콘 생성 (2026-11-16, 사용자 요청: Muse처럼 둥글게).

디자인: 흰→연한 파스텔 블루 그라데이션 스쿼클 + 네이비 JN 모노그램.
- icon-512.png / icon-192.png: 투명 모서리의 둥근 스쿼클 (RGBA).
  윈도우 바탕화면·맥 독에서 네모 흰 판이 아니라 앱 아이콘처럼 보인다.
- icon-512-maskable.png: 마스커블용 전체 채움 + JN은 80% 안전 영역 안.
- apple-touch-icon.png: iOS가 자체 라운드를 씌우므로 전체 채움 (불투명).

폰트: public/fonts/Inter-Bold.ttf (자체 호스팅).
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = "public/fonts/Inter-Bold.ttf"
NAVY = (20, 20, 58, 255)
TOP = (255, 255, 255)
BOTTOM = (226, 236, 246)  # 연한 파스텔 블루
SIZE = 1024
RADIUS = int(SIZE * 0.225)  # iOS 스타일 스쿼클 근사


def gradient(size):
    img = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        img.putpixel((0, y), tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_jn(draw, size, font, color):
    text = "JN"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=font, fill=color)


def build_squircle(size, radius_frac=0.225):
    """투명 모서리 스쿼클 + 그라데이션 + JN."""
    base = gradient(size).convert("RGBA")
    mask = rounded_mask(size, int(size * radius_frac))
    base.putalpha(mask)
    # 가장자리에 아주 옅은 테두리 — 흰 배경에서도 형태가 보이게.
    edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(edge)
    d.rounded_rectangle([1, 1, size - 2, size - 2], radius=int(size * radius_frac),
                        outline=(120, 140, 170, 60), width=max(2, size // 512))
    base = Image.alpha_composite(base, edge)
    font = ImageFont.truetype(FONT, int(size * 0.52))
    d = ImageDraw.Draw(base)
    draw_jn(d, size, font, NAVY)
    return base


def build_filled(size):
    """전체 채움 (마스커블·애플 터치용) — JN은 80% 안전 영역 안."""
    base = gradient(size).convert("RGBA")
    font = ImageFont.truetype(FONT, int(size * 0.42))
    d = ImageDraw.Draw(base)
    draw_jn(d, size, font, NAVY)
    return base.convert("RGB")


def main():
    squircle = build_squircle(SIZE)
    squircle.resize((512, 512), Image.LANCZOS).save("public/icon-512.png", optimize=True)
    squircle.resize((192, 192), Image.LANCZOS).save("public/icon-192.png", optimize=True)
    build_filled(512).save("public/icon-512-maskable.png", optimize=True)
    build_filled(180).save("public/apple-touch-icon.png", optimize=True)
    print("icon-512.png, icon-192.png, icon-512-maskable.png, apple-touch-icon.png written")


if __name__ == "__main__":
    main()
