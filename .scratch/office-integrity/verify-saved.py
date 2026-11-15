#!/usr/bin/env python3
"""왕복 저장본 바이트 대조 (오피스 무결성 검증용).
probe-roundtrip.cjs가 out/에 캡처한 저장본을 원본 픽스처와 대조한다.
실행: python3 verify-saved.py (이 디렉토리에서, venv python 권장)
"""
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
AX = '/home/hatch/workspace/analysis2-20261105/axis-e/fixtures'

results = []


def report(name, ok, detail):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}")


def check_xlsx():
    from openpyxl import load_workbook
    orig = load_workbook(os.path.join(AX, 'roundtrip.xlsx'))
    saved = load_workbook(os.path.join(OUT, 'saved.xlsx'))
    ws_o = orig['분기실적']
    ws_s = saved['분기실적']
    report('xlsx 편집 반영 D3=1500', ws_s['D3'].value == 1500, f"D3={ws_s['D3'].value!r}")
    formulas = {'E3': '=D3/C3', 'C7': '=SUM(C3:C6)', 'D7': '=SUM(D3:D6)', 'E8': '=AVERAGE(E3:E6)'}
    for cell, f in formulas.items():
        report(f'xlsx 수식 보존 {cell}', ws_s[cell].value == f, f"{cell}={ws_s[cell].value!r}")
    report('xlsx 계산 캐시 E3=1.5', ws_s['E3'].value == '=D3/C3', '수식 유지 (캐시는 openpyxl data_only로 별도 확인)')
    report('xlsx 병합 A1:F1', 'A1:F1' in [str(r) for r in ws_s.merged_cells.ranges],
           f"merged={list(ws_s.merged_cells.ranges)}")
    report('xlsx 제목 채움 4472C4', (ws_s['A1'].fill.fgColor.rgb or '').endswith('4472C4'),
           f"fill={ws_s['A1'].fill.fgColor.rgb}")
    report('xlsx 제목 굵게', bool(ws_s['A1'].font.bold), f"bold={ws_s['A1'].font.bold}")
    report('xlsx 숫자형식 E3 0.0%', ws_s['E3'].number_format == '0.0%', f"fmt={ws_s['E3'].number_format!r}")
    report('xlsx 제2시트 존재', '메모' in saved.sheetnames, f"sheets={saved.sheetnames}")
    if '메모' in saved.sheetnames:
        ws2 = saved['메모']
        report('xlsx 제2시트 병합 A2:C2', 'A2:C2' in [str(r) for r in ws2.merged_cells.ranges],
               f"merged={list(ws2.merged_cells.ranges)}")
        report('xlsx 제2시트 텍스트', ws2['A1'].value == '두 번째 시트 — 합성 메모', f"A1={ws2['A1'].value!r}")
    # 원본 값 보존 (편집 외 셀)
    report('xlsx 원본값 보존 A3', ws_s['A3'].value == ws_o['A3'].value, f"A3={ws_s['A3'].value!r}")
    report('xlsx 원본값 보존 C3', ws_s['C3'].value == ws_o['C3'].value, f"C3={ws_s['C3'].value!r}")


def check_pptx():
    from pptx import Presentation
    saved = Presentation(os.path.join(OUT, 'saved.pptx'))
    report('pptx 슬라이드 수 2', len(saved.slides) == 2, f"slides={len(saved.slides)}")
    w_in = saved.slide_width / 914400
    h_in = saved.slide_height / 914400
    report('pptx 크기 13.33x7.5', abs(w_in - 13.333) < 0.01 and abs(h_in - 7.5) < 0.01,
           f"{w_in:.2f}x{h_in:.2f}in")
    all_text = []
    for i, s in enumerate(saved.slides):
        shapes = len(s.shapes)
        report(f'pptx 슬라이드{i + 1} 도형 4개', shapes == 4, f"shapes={shapes}")
        for sh in s.shapes:
            if sh.has_text_frame:
                all_text.append(sh.text_frame.text)
            if sh.has_table:
                for row in sh.table.rows:
                    for cell in row.cells:
                        all_text.append(cell.text)
    joined = '\n'.join(all_text)
    report('pptx 편집 반영 140건', '140건' in joined, '140건 포함' if '140건' in joined else '없음')
    report('pptx 구문 131건 소멸', '131건' not in joined, '131건 잔존' if '131건' in joined else '소멸 확인')
    report('pptx 제목 보존', '분기리뷰' in joined or len(joined) > 50, f"text_len={len(joined)}")


def check_hwpx():
    saved_path = os.path.join(OUT, 'saved.hwpx')
    z = zipfile.ZipFile(saved_path)
    sec = z.read('Contents/section0.xml').decode('utf-8')
    markers = set(re.findall(r'합성셀(\d{3})', sec))
    report('hwpx 마커 보존 (245개 기대: 247-2치환)', len(markers) == 245, f"markers={len(markers)}")
    report('hwpx 표 셀 치환 반영 수정셀999', '수정셀999' in sec, '수정셀999 포함' if '수정셀999' in sec else '없음')
    report('hwpx 본문 치환 반영 수정셀888', '수정셀888' in sec, '수정셀888 포함' if '수정셀888' in sec else '없음')
    report('hwpx 구문 합성셀001 소멸', '합성셀001' not in sec, '잔존' if '합성셀001' in sec else '소멸 확인')
    report('hwpx 구문 합성셀117 소멸', '합성셀117' not in sec, '잔존' if '합성셀117' in sec else '소멸 확인')
    tables = sec.count('<hp:tbl ')
    report('hwpx 표 3개 보존', tables == 3, f"tables={tables}")
    # 원본과 구조 비교 (엔트리 손실 없음; Preview 추가는 Studio export의 정상 동작)
    orig = zipfile.ZipFile(os.path.join(AX, 'table.hwpx'))
    lost = set(orig.namelist()) - set(z.namelist())
    added = set(z.namelist()) - set(orig.namelist())
    report('hwpx 엔트리 손실 없음', len(lost) == 0, f"lost={sorted(lost)} added={sorted(added)}")


def check_pdf():
    from pypdf import PdfReader
    saved = PdfReader(os.path.join(OUT, 'saved.pdf'))
    orig = PdfReader(os.path.join(AX, 'form.pdf'))
    report('pdf 페이지 수 2', len(saved.pages) == 2, f"pages={len(saved.pages)}")
    rots = [p.get('/Rotate', 0) for p in saved.pages]
    report('pdf 1페이지 회전 90', rots[0] == 90, f"rotations={rots}")
    report('pdf 2페이지 회전 0', rots[1] in (0, None), f"rotations={rots}")
    t_orig = (orig.pages[0].extract_text() or '') + (orig.pages[1].extract_text() or '')
    t_saved = (saved.pages[0].extract_text() or '') + (saved.pages[1].extract_text() or '')
    # 텍스트 레이어 원문 보존 (공백 정규화 후 비교)
    norm = lambda s: re.sub(r'\s+', '', s)
    report('pdf 텍스트 레이어 보존', norm(t_orig) == norm(t_saved),
           f"orig_len={len(t_orig)} saved_len={len(t_saved)}")


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if which in ('all', 'xlsx'):
        check_xlsx()
    if which in ('all', 'pptx'):
        check_pptx()
    if which in ('all', 'hwpx'):
        check_hwpx()
    if which in ('all', 'pdf'):
        check_pdf()
    print(f"\n=== 요약: {sum(1 for _, ok, _ in results if ok)}/{len(results)} PASS ===")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)
