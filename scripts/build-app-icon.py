#!/usr/bin/env python3
"""MyHub 앱 아이콘 생성 (2026-11-16, 사용자 요청: Muse처럼 둥글게).

디자인: 흰→연한 파스텔 블루 그라데이션 스쿼클 + 기존 JN 마크.
- JN 마크는 기존 아이콘(jn-mark-source.png, 구 icon-512.png)에서 픽셀 추출 —
  J 아래쪽이 평평하게 꺾이는 독특한 형태라 폰트 재현이 안 된다.
  사용자 2026-11-16: "jn 글씨자체는 기존께 더마음에드는데? 더마크같고".
- icon-512.png / icon-192.png: 투명 모서리의 둥근 스쿼클 (RGBA).
- icon-512-maskable.png: 마스커블용 전체 채움.
- apple-touch-icon.png: iOS가 자체 라운드를 씌우므로 전체 채움 (불투명).

마스터는 512 (마크 원본 해상도와 동일 — 업스케일 없이 픽셀 그대로).
"""
from PIL import Image, ImageDraw

MARK_SRC = "scripts/jn-mark-source.png"
# 구 아이콘 속 JN 바운딩 박스 (실측)
MARK_BBOX = (84, 156, 428, 360)
NAVY = (20, 18, 70, 255)
TOP = (255, 255, 255)
BOTTOM = (226, 236, 246)  # 연한 파스텔 블루
SIZE = 512
RADIUS = int(SIZE * 0.225)  # iOS 스타일 스쿼클 근사
MARK_WIDTH = 344  # 구 아이콘과 동일 비율 (67%)


def extract_mark():
    """구 아이콘에서 JN을 알파 마스크로 추출해 네이비로 채색."""
    src = Image.open(MARK_SRC).convert("L")
    crop = src.crop(MARK_BBOX)
    # 흰 배경 → 투명, 네이비 → 불투명 (안티앨리어싱은 회색값이 보존)
    alpha = crop.point(lambda v: 255 - v)
    mark = Image.new("RGBA", crop.size, NAVY)
    mark.putalpha(alpha)
    return mark


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


def paste_mark(base, mark, width):
    scale = width / mark.width
    resized = mark.resize((width, int(mark.height * scale)), Image.LANCZOS)
    x = (base.width - resized.width) // 2
    y = (base.height - resized.height) // 2
    base.alpha_composite(resized, (x, y))
    return base


def build_squircle(mark):
    base = gradient(SIZE).convert("RGBA")
    base.putalpha(rounded_mask(SIZE, RADIUS))
    edge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(edge)
    d.rounded_rectangle([1, 1, SIZE - 2, SIZE - 2], radius=RADIUS,
                        outline=(120, 140, 170, 60), width=2)
    base = Image.alpha_composite(base, edge)
    return paste_mark(base, mark, MARK_WIDTH)


def build_filled(mark, size):
    base = gradient(size).convert("RGBA")
    return paste_mark(base, mark, int(size * MARK_WIDTH / SIZE)).convert("RGB")


def main():
    mark = extract_mark()
    squircle = build_squircle(mark)
    squircle.save("public/icon-512.png", optimize=True)
    squircle.resize((192, 192), Image.LANCZOS).save("public/icon-192.png", optimize=True)
    build_filled(mark, 512).save("public/icon-512-maskable.png", optimize=True)
    build_filled(mark, 180).save("public/apple-touch-icon.png", optimize=True)
    print("icon-512.png, icon-192.png, icon-512-maskable.png, apple-touch-icon.png written")


if __name__ == "__main__":
    main()
