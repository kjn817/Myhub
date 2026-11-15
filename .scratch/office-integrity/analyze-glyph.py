#!/usr/bin/env python3
"""스크린샷 글리프 채움 분석기 (오피스 무결성 검증용) v2.

줄 단위 집계는 글리프별 경계를 뭉개서 image-54 결함을 놓친다.
글리프 단위로 분석한다: 각 텍스트 줄에서 열 기준 글리프 클러스터를
분리하고, 글리프별 (a) 상부 40% 잉크 밀도 vs 하부 60% (b) 상부 잉크 중
내부(3x3 전 이웃 잉크) 비율을 잰다. 속 빈 윤곽선만 남은 상부는 내부
비율이 0에 가깝다; 정상 채움은 내부 비율이 높다.

사용법: python3 analyze-glyph.py <shot.png> [shot2.png ...]
출력: 줄·글리프별 지표 + HOLLOW_TOP 의심 여부 (JSON 한 줄씩).
"""
import json
import sys

import numpy as np
from PIL import Image


def glyph_clusters(ink_row_band, min_w=6):
    """한 줄 밴드(2D bool)에서 열 기준 글리프 클러스터 분리. (x0, x1) 목록."""
    col_has = ink_row_band.any(axis=0)
    clusters = []
    start = None
    for x, has in enumerate(col_has):
        if has and start is None:
            start = x
        elif not has and start is not None:
            if x - start >= min_w:
                clusters.append((start, x - 1))
            start = None
    if start is not None and len(col_has) - start >= min_w:
        clusters.append((start, len(col_has) - 1))
    return clusters


def enclosed_white_near_top(ink, top_frac=0.06, max_h_frac=0.25):
    """글리프 상단 끝(top_frac 이내)에 있고 높이가 작은 둘러싸인 흰 영역 수.
    정상 글리프의 카운터(ㅁ·ㅇ 구멍 등)는 상단 끝에서 떨어져 있다(위쪽
    획이 있음). image-54 결함의 흰 사각형은 글리프 최상단에 닿아 있다.
    top_frac 0.15는 ㅁ 카운터를 오탐하므로 0.06으로 좁힌다.
    flood fill로 이미지 경계에 닿지 않는 흰 컴포넌트를 찾는다."""
    from collections import deque
    h, w = ink.shape
    white = ~ink
    # 경계에 닿는 흰 영역을 먼저 표시 (바깥)
    outside = np.zeros_like(white)
    dq = deque()
    for x in range(w):
        if white[0, x] and not outside[0, x]:
            outside[0, x] = True; dq.append((0, x))
        if white[h - 1, x] and not outside[h - 1, x]:
            outside[h - 1, x] = True; dq.append((h - 1, x))
    for y in range(h):
        if white[y, 0] and not outside[y, 0]:
            outside[y, 0] = True; dq.append((y, 0))
        if white[y, w - 1] and not outside[y, w - 1]:
            outside[y, w - 1] = True; dq.append((y, w - 1))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and white[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                dq.append((ny, nx))
    enclosed = white & ~outside
    # 둘러싸인 흰 컴포넌트 중 상단에 있는 것
    seen = np.zeros_like(enclosed)
    count = 0
    for y in range(h):
        for x in range(w):
            if not enclosed[y, x] or seen[y, x]:
                continue
            # 컴포넌트 flood fill
            comp = []
            dq.append((y, x))
            seen[y, x] = True
            while dq:
                cy, cx = dq.popleft()
                comp.append((cy, cx))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and enclosed[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        dq.append((ny, nx))
            ys = [c[0] for c in comp]
            top_y = min(ys)
            comp_h = max(ys) - top_y + 1
            if top_y <= h * top_frac and comp_h <= h * max_h_frac and len(comp) >= 9:
                count += 1
    return count


def interior_fraction(ink):
    """잉크 픽셀 중 3x3 이웃이 전부 잉크인(내부) 비율."""
    if ink.sum() == 0:
        return 0.0
    padded = np.pad(ink, 1, constant_values=False)
    neigh = (
        padded[:-2, :-2] & padded[:-2, 1:-1] & padded[:-2, 2:]
        & padded[1:-1, :-2] & padded[1:-1, 2:]
        & padded[2:, :-2] & padded[2:, 1:-1] & padded[2:, 2:]
    )
    interior = ink & neigh
    return float(interior.sum() / ink.sum())


def analyze(path):
    im = Image.open(path).convert('L')
    a = np.array(im)
    ink = a < 128
    rows = np.where(ink.any(axis=1))[0]
    if len(rows) == 0:
        return {'file': path, 'lines': [], 'verdict': 'NO_INK', 'note': '잉크 없음 (빈 렌더?)'}
    groups = []
    start = rows[0]
    prev = rows[0]
    for r in rows[1:]:
        if r - prev > 8:
            groups.append((start, prev))
            start = r
        prev = r
    groups.append((start, prev))
    lines = []
    hollow = False
    for (g0, g1) in groups:
        h = g1 - g0 + 1
        if h < 12:
            continue
        band = ink[g0:g1 + 1, :]
        glyphs = []
        for (x0, x1) in glyph_clusters(band):
            g_raw = band[:, x0:x1 + 1]
            # 글리프 자체의 수직 bbox로 트림 (줄 밴드 높이와 다를 수 있음 —
            # 짧은 글리프는 밴드 상부가 비어 top15가 0이 되는 오탐 방지)
            grows = np.where(g_raw.any(axis=1))[0]
            if len(grows) == 0:
                continue
            g = g_raw[grows.min():grows.max() + 1, :]
            gh = g.shape[0]
            top = g[:int(gh * 0.4), :]
            bot = g[int(gh * 0.4):, :]
            top_density = float(top.mean())
            bot_density = float(bot.mean())
            top_interior = interior_fraction(top)
            bot_interior = interior_fraction(bot)
            top15 = g[:max(int(gh * 0.15), 1), :]
            top15_density = float(top15.mean())
            enclosed_top = enclosed_white_near_top(g)
            # 내부-비율 규칙은 큰 글리프에만 적용: 작은 글리프(획 1~2px)는
            # 정상이어도 3x3 내부가 없어 오탐한다.
            interior_suspect = (
                gh >= 40
                and top15_density < 0.5 * max(bot_density, 0.01)
                and top_interior < 0.15
            )
            suspect = enclosed_top > 0 or interior_suspect
            if suspect:
                hollow = True
            glyphs.append({
                'x': [int(x0), int(x1)], 'w': int(x1 - x0 + 1),
                'top40_density': round(top_density, 3),
                'bot60_density': round(bot_density, 3),
                'top40_interior': round(top_interior, 2),
                'bot60_interior': round(bot_interior, 2),
                'top15_density': round(top15_density, 3),
                'enclosed_white_top': enclosed_top,
                'hollow_top_suspect': suspect,
            })
        lines.append({'y': [int(g0), int(g1)], 'height': int(h), 'glyphs': glyphs})
    suspects = sum(1 for ln in lines for g in ln['glyphs'] if g['hollow_top_suspect'])
    total = sum(len(ln['glyphs']) for ln in lines)
    return {
        'file': path,
        'lines': lines,
        'glyphs_total': total,
        'glyphs_suspect': suspects,
        'verdict': 'HOLLOW_TOP_SUSPECT' if hollow else ('OK' if total else 'NO_GLYPHS'),
    }


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(json.dumps(analyze(p), ensure_ascii=False))
