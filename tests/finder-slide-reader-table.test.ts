/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/// <reference types="jest" />
/**
 * PPTX 리더 텍스트 추출 — 표 포함 슬라이드 회귀 (2026-11-11)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - extractSlideParagraphs는 실제 텍스트 노드(a:t)의 내용만 뽑는다.
 *   표(a:tbl)가 든 슬라이드에서도 반환 문자열에 원시 XML 조각
 *   ('<a:' '<p:' 같은 마크업)이 절대 섞이지 않는다.
 * - 일반 플레이스홀더 문단과 표 셀 문단이 모두 추출된다.
 *
 * 결함 경위: 추출 정규식 /<a:t[^>]*>/가 태그 경계를 보지 않아
 * a:txBody·a:tblPr·a:tc까지 매칭해 표 XML 원문이 리더에 노출됐다
 * (실브라우저 실증 track-pptx, 시험 파일 b). 전사본 428행에도 같은
 * 정규식이 있는 원본 기존 결함 — 태그 경계를 넣어 개선한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const SLIDE_JS = fs.readFileSync(
  path.join(ROOT, 'public/js/finder-format-slide.js'),
  'utf-8',
)

const getWin = (): any => (globalThis as any).window

function loadApi(): any {
  const win = getWin()
  win.MyHubFinderViewer = { registerFormat: jest.fn() }
  new Function('window', 'document', SLIDE_JS)(win, getWin().document)
  return win.MyHubFinderFormatSlide
}

const TITLE_AND_TABLE_XML = [
  '<p:sld><p:cSld><p:spTree>',
  '<p:sp><p:txBody><a:p><a:r><a:t>제목 텍스트</a:t></a:r></a:p></p:txBody></p:sp>',
  '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>',
  '<a:tblPr firstRow="1"></a:tblPr>',
  '<a:tr>',
  '<a:tc><a:txBody><a:p><a:r><a:t>셀 하나</a:t></a:r></a:p></a:txBody></a:tc>',
  '<a:tc><a:txBody><a:p><a:r><a:t>셀 둘</a:t></a:r></a:p></a:txBody></a:tc>',
  '</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>',
  '</p:spTree></p:cSld></p:sld>',
].join('')

describe('extractSlideParagraphs — 표 포함 슬라이드', () => {
  it('표 XML 원문이 새지 않고 셀 텍스트가 추출된다', () => {
    const api = loadApi()
    const paragraphs: string[] = api.extractSlideParagraphs(TITLE_AND_TABLE_XML)
    expect(paragraphs).toContain('제목 텍스트')
    expect(paragraphs).toContain('셀 하나')
    expect(paragraphs).toContain('셀 둘')
    for (const p of paragraphs) {
      expect(p).not.toMatch(/<[a-z]+:/)
      expect(p).not.toContain('a:tbl')
      expect(p).not.toContain('txBody')
    }
  })

  it('속성이 붙은 a:t도 추출된다', () => {
    const api = loadApi()
    const xml =
      '<p:sp><p:txBody><a:p><a:r><a:t lang="ko-KR">속성 문단</a:t></a:r></a:p></p:txBody></p:sp>'
    expect(api.extractSlideParagraphs(xml)).toContain('속성 문단')
  })
})
