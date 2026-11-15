#!/usr/bin/env python3
"""오피스 무결성 검증용 폰트 픽스처 생성 (전부 합성 데이터).

- font-xlsx.xlsx: 나눔고딕/맑은 고딕/함초롬돋움 셀 + 숫자·수식
- font-pptx.pptx: 슬라이드 2장, 폰트 3종
- font-hwpx.hwpx: blank.hwpx 복제 + 나눔고딕/맑은 고딕 문단 3개 주입
실행: python3 make-fixtures.py (이 디렉토리에서)
"""
import os
import re
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
os.makedirs(OUT, exist_ok=True)


def build_xlsx():
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = '폰트테스트'
    ws['A1'] = '나눔고딕 한글 테스트'
    ws['A1'].font = Font(name='NanumGothic', size=16, bold=True)
    ws['A2'] = '맑은 고딕 테스트'
    ws['A2'].font = Font(name='맑은 고딕', size=14)
    ws['A3'] = '함초롬돋움 테스트'
    ws['A3'].font = Font(name='함초롬돋움', size=14)
    ws['A4'] = 12345
    ws['A5'] = '=A4*2'
    ws['B1'] = 'English ABC 123'
    ws['B1'].font = Font(name='Calibri', size=12)
    ws.column_dimensions['A'].width = 32
    ws.column_dimensions['B'].width = 20
    p = os.path.join(OUT, 'font-xlsx.xlsx')
    wb.save(p)
    print('wrote', p, os.path.getsize(p))


def build_pptx():
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    def add_text(slide, left, top, width, height, text, font_name, size, bold=False):
        box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
        tf = box.text_frame
        tf.word_wrap = True
        para = tf.paragraphs[0]
        run = para.add_run()
        run.text = text
        run.font.name = font_name
        run.font.size = Pt(size)
        run.font.bold = bold
        # python-pptx는 latin typeface만 쓰므로 east asian도 같은 폰트로 명시
        rPr = run._r.get_or_add_rPr()
        ea = rPr.makeelement('{http://schemas.openxmlformats.org/drawingml/2006/main}ea',
                             {'typeface': font_name})
        rPr.append(ea)

    s1 = prs.slides.add_slide(blank)
    add_text(s1, 0.8, 0.6, 11.0, 1.2, '나눔고딕 제목 테스트', 'NanumGothic', 44, True)
    add_text(s1, 0.8, 2.2, 11.0, 1.0, '맑은 고딕 본문 테스트 가나다라 마바사', '맑은 고딕', 24)
    add_text(s1, 0.8, 3.6, 11.0, 1.0, '숫자 12345 · 영문 ABC abc', 'NanumGothic', 20)
    s2 = prs.slides.add_slide(blank)
    add_text(s2, 0.8, 0.6, 11.0, 1.2, '함초롬돋움 슬라이드', '함초롬돋움', 32, True)
    add_text(s2, 0.8, 2.2, 11.0, 1.0, '두 번째 슬라이드 본문', 'NanumGothic', 24)
    p = os.path.join(OUT, 'font-pptx.pptx')
    prs.save(p)
    print('wrote', p, os.path.getsize(p))


def build_hwpx():
    src = os.path.join(REPO, 'public', 'templates', 'blank.hwpx')
    dst = os.path.join(OUT, 'font-hwpx.hwpx')
    zin = zipfile.ZipFile(src)
    header = zin.read('Contents/header.xml').decode('utf-8')
    section = zin.read('Contents/section0.xml').decode('utf-8')

    # 1) HANGUL fontface에 나눔고딕(id 2)·맑은 고딕(id 3) 추가
    typeinfo = ('<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" '
                'contrast="0" strokeVariation="1" armStyle="1" letterform="1" '
                'midline="1" xHeight="1"/>')
    new_fonts = (
        f'<hh:font id="2" face="NanumGothic" type="TTF" isEmbedded="0">{typeinfo}</hh:font>'
        f'<hh:font id="3" face="맑은 고딕" type="TTF" isEmbedded="0">{typeinfo}</hh:font>'
    )
    hangul_face = re.search(
        r'(<hh:fontface lang="HANGUL" fontCnt=")2(">)', header)
    assert hangul_face, 'HANGUL fontface not found'
    header = header[:hangul_face.start()] + hangul_face.group(1) + '4' + hangul_face.group(2) + header[hangul_face.end():]
    # HANGUL fontface 닫는 태그 직전에 새 폰트 삽입
    hangul_close = header.find('</hh:fontface>', hangul_face.start())
    header = header[:hangul_close] + new_fonts + header[hangul_close:]

    # 2) charPr 추가: id 7 나눔고딕 24pt, id 8 나눔고딕 12pt, id 9 맑은 고딕 12pt
    def char_pr(cid, font_id, height):
        return (
            f'<hh:charPr id="{cid}" height="{height}" textColor="#000000" shadeColor="none" '
            f'useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">'
            f'<hh:fontRef hangul="{font_id}" latin="{font_id}" hanja="{font_id}" '
            f'japanese="{font_id}" other="{font_id}" symbol="{font_id}" user="{font_id}"/>'
            f'<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" '
            f'symbol="100" user="100"/>'
            f'<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" '
            f'symbol="0" user="0"/>'
            f'<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" '
            f'symbol="100" user="100"/>'
            f'<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" '
            f'symbol="0" user="0"/>'
            f'<hh:underline type="NONE" shape="SOLID" color="#000000"/>'
            f'<hh:strikeout shape="NONE" color="#000000"/>'
            f'<hh:outline type="NONE"/>'
            f'<hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>'
            f'</hh:charPr>'
        )
    new_prs = char_pr(7, 2, 2400) + char_pr(8, 2, 1200) + char_pr(9, 3, 1200)
    m = re.search(r'(<hh:charProperties itemCnt=")7(">)', header)
    assert m, 'charProperties not found'
    header = header[:m.start()] + m.group(1) + '10' + m.group(2) + header[m.end():]
    cp_close = header.find('</hh:charProperties>')
    header = header[:cp_close] + new_prs + header[cp_close:]

    # 3) section0에 문단 3개 주입 (첫 문단 뒤)
    def para(pid, char_pr_id, text):
        return (
            f'<hp:p id="{pid}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" '
            f'columnBreak="0" merged="0"><hp:run charPrIDRef="{char_pr_id}">'
            f'<hp:t>{text}</hp:t></hp:run></hp:p>'
        )
    new_paras = (
        para(1, 7, '나눔고딕 한글 제목 테스트')
        + para(2, 8, '나눔고딕 본문 가나다라 마바사 12345')
        + para(3, 9, '맑은 고딕 본문 가나다라 마바사')
    )
    first_close = section.find('</hp:p>')
    assert first_close > 0, 'first paragraph close not found'
    section = section[:first_close + len('</hp:p>')] + new_paras + section[first_close + len('</hp:p>'):]

    zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        if item.filename == 'Contents/header.xml':
            zout.writestr(item, header.encode('utf-8'))
        elif item.filename == 'Contents/section0.xml':
            zout.writestr(item, section.encode('utf-8'))
        elif item.filename == 'Preview/PrvText.txt':
            zout.writestr(item, '나눔고딕 한글 제목 테스트\n'.encode('utf-8'))
        else:
            zout.writestr(item, zin.read(item.filename))
    zout.close()
    zin.close()
    print('wrote', dst, os.path.getsize(dst))


if __name__ == '__main__':
    build_xlsx()
    build_pptx()
    build_hwpx()
