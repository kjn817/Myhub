/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * S5-5 후속 패스 (깨진 한국어 잔여 복원) 계약 테스트.
 *
 * 고정하는 성질 (설계 노트 .scratch/s6-cleanup-design.md "S5-5 후속 패스"):
 * - 전사본 모지바케 역변환(CP949 2바이트 소비 디코드)으로 verify.py MATCH
 *   확정된 복원 문장이 파일에 존재한다. 복원이 되돌아가면 핀이 실패한다.
 * - 깨진 토큰이 후속 패스 파일 11개에 다시 들어가지 않는다. 단, 범위 밖
 *   잔여(다이얼로·합체 프레임·주소으로·대관·온라인)는 이번 패스에서
 *   고치지 않았으므로 스캔 대상에서 제외한다 (설계 노트 범위 밖 절).
 * - '서면'은 허용 목록 4곳에만 남는다 (pdf-ops:5 "페이지 번호 서면",
 *   finder.js:2959·:2983 "서면에", deckcraft:437 "서면한" — 복원 불가).
 *   그 외 곳에 '서면'이 나타나면 실패한다.
 * - format-sheet/gridcraft/fonts 헤더는 코드 사실 기반으로 재작성됐다 —
 *   핵심 문장이 존재한다.
 *
 * 카나리아: pdfcraft 헤더에 '위치끈'을 다시 넣으면 토큰 스캔이,
 * craft-prefetch-core.js:6의 "페이지"를 "서면"으로 되돌리면 복원 문장
 * 핀과 서면 스캔이 실패한다 (설계 노트 카나리아 절).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8')
}

// 후속 패스에서 손댄 파일 11개.
const FOLLOWUP_FILES = [
  'public/js/finder-pdfcraft.js',
  'public/js/finder-pdf-ops.js',
  'public/js/finder-deckcraft.js',
  'public/js/deckcraft-prefetch.js',
  'public/js/gridcraft-prefetch.js',
  'public/js/craft-prefetch-core.js',
  'public/js/craft-clipboard.js',
  'public/js/finder.js',
  'public/js/finder-format-sheet.js',
  'public/js/sheet-gridcraft.js',
  'public/js/fonts.js',
]

describe('S5-5 후속 — 복원 문장 핀 (모지바케 역변환 확정)', () => {
  const PINS: Array<[string, string]> = [
    // finder-pdfcraft.js
    ['public/js/finder-pdfcraft.js', '파인더 뷰어 포맷 보조 모듈'],
    ['public/js/finder-pdfcraft.js', '자체 열기는 호스트 위임(pdfcraft:request-open)이 다운스트림 패치로'],
    ['public/js/finder-pdfcraft.js', '이 모듈은 그 지(호스트 층)만 맡는다 — iframe 생성·출처 검증·ready'],
    ['public/js/finder-pdfcraft.js', '워치독·메시지 정규화. 표면 전환(접기/펼치기·폴백)과 저장은'],
    ['public/js/finder-pdfcraft.js', '무게 대책: WASM은 raw 36MB라 Finder를 열 때 유휴 시간은 매니페스트의'],
    ['public/js/finder-pdfcraft.js', '진입 에셋을 미리 받아 둔다 (아래 prefetch). WASM은 에셋 상한(25MB)을'],
    ['public/js/finder-pdfcraft.js', '받아 이어 붙인다 — 프리페치 대상도 그 조각들과 로더다.'],
    ['public/js/finder-pdfcraft.js', '다운스트림 패치가 제공하는 표면이다.'],
    ['public/js/finder-pdfcraft.js', 'ready 워치독: 콜드 기동(전송+36MB 컴파일)에 느린 기기까지 기다린다.'],
    ['public/js/finder-pdfcraft.js', '이 안에 ready가 없으면 호스트가 pdf.js 표면으로 남는다.'],
    ['public/js/finder-pdfcraft.js', 'onRequestOpen은 엔진이 자체 열기가 호스트로 위임한 것이다'],
    ['public/js/finder-pdfcraft.js', 'onFallback은 ready 워치독 초과'],
    ['public/js/finder-pdfcraft.js', '표면으로 남으면 된다 (폴백 보존의 계약).'],
    ['public/js/finder-pdfcraft.js', '97% 번역돼 있어도 표면 전체가 영어로 뜬다'],
    ['public/js/finder-pdfcraft.js', '오피스 표면에서는 앱 게이트로 건너뛴다'],
    ['public/js/finder-pdfcraft.js', '매니페스트에서 뽑은 진입 에셋은 해시 파일명이은 파일명 자체가'],
    ['public/js/finder-pdfcraft.js', '그쪽에는 붙이지 않는다 — 파일명이 고정된 매니페스트 자체만'],
    // finder-pdf-ops.js
    ['public/js/finder-pdf-ops.js', '있다: 페이지 번호 서면은 1-based'],
    ['public/js/finder-pdf-ops.js', '얹는다 (래스터라 검색·복사는 안 된다 이'],
    // finder-deckcraft.js
    ['public/js/finder-deckcraft.js', '파인더 뷰어 포맷 보조 모듈'],
    ['public/js/finder-deckcraft.js', '다운스트림 패치(Stage C)로 임베드용 호스트 브리지를 갖는다'],
    ['public/js/finder-deckcraft.js', 'ready 워치독·exec 태그 관리'],
    ['public/js/finder-deckcraft.js', '리더 표면이 남는다 (폴백 보존의 계약).'],
    ['public/js/finder-deckcraft.js', 'NanumGothic 획이 같은 순서(맥 앱)는 들어 있어 한글 보장이 같다.'],
    ['public/js/finder-deckcraft.js', 'onRequestOpen은 엔진의 파일 선택이 호스트에 위임한 것이다'],
    ['public/js/finder-deckcraft.js', '삽입·테마 찾아보기). 표면은 보관함 피커로 고른 파일을'],
    ['public/js/finder-deckcraft.js', '기본 계약이라 답을 보내지 않으면 된다 (명시 취소는 cancelPick).'],
    ['public/js/finder-deckcraft.js', '최대 두 번만 불린다 이 호스트는 그때 이 세션을 destroy하고 최소'],
    ['public/js/finder-deckcraft.js', '리더 표면으로 남으면 된다 (폴백 보존의 계약).'],
    ['public/js/finder-deckcraft.js', '표면 문서(뷰어 크롬)는 표면'],
    ['public/js/finder-deckcraft.js', '일어난 최종 크기+적용된 폰트로 배치가 확정된다.'],
    ['public/js/finder-deckcraft.js', '인쇄 전용 채널 (인쇄 정본)'],
    ['public/js/finder-deckcraft.js', '인쇄는 PDF는 앱 저장도 다운로드는 아니라, 표면은 남은 프레임'],
    ['public/js/finder-deckcraft.js', '으로 시스템 인쇄 대화상자를 여는 것이 유일한 때비 방식이다.'],
    ['public/js/finder-deckcraft.js', '취소를 생해와 계약의 문제는 없다 (엔진에 답 없는 요청은'],
    ['public/js/finder-deckcraft.js', '그냥 남겨 두며, id는 재사용되지 않는다).'],
    ['public/js/finder-deckcraft.js', '오피스 표면에서는 앱 게이트로 건너뛴다'],
    // prefetch
    ['public/js/deckcraft-prefetch.js', '표면에서는 앱 게이트로 건너뛴다'],
    ['public/js/deckcraft-prefetch.js', '규칙으로 해시 파일명이'],
    ['public/js/gridcraft-prefetch.js', '표면에서는 앱 게이트로 건너뛴다'],
    ['public/js/gridcraft-prefetch.js', '자산은 해시 파일명 + immutable 캐시며'],
    // craft-prefetch-core.js / craft-clipboard.js
    ['public/js/craft-prefetch-core.js', '이 파일을 먼저 받은 페이지에서만 래퍼가 동작한다'],
    ['public/js/craft-prefetch-core.js', '자동 부팅 게이트: 오피스 표면이면 자동 실행 안 함'],
    ['public/js/craft-prefetch-core.js', '오피스 표면 판정: office.html은 한 번에 두 포맷(?app=)만 열고 그'],
    ['public/js/craft-prefetch-core.js', '엔진의 문서를 두 대 iframe이 직접 받으므로, 진입 시점의 두 엔진을'],
    ['public/js/craft-prefetch-core.js', '데우는 자동 프리페치는 오피스에서 하지 않는다 (지연 로드 두 엔진을'],
    ['public/js/craft-prefetch-core.js', '자동 프리패치 예약: 오피스 표면·데이터 절약 모드에서는 건너뛰고,'],
    ['public/js/craft-prefetch-core.js', 'manifest.json에서 진입 에셋 URL을 만든다.'],
    ['public/js/craft-clipboard.js', '이 파일을 먼저 받은 페이지에서만 소비처가 동작한다'],
    // finder.js
    ['public/js/finder.js', '사유를 들어 거부한다 (현재 폴더가 화면에 보이지 않으므로).'],
    ['public/js/finder.js', '데(명확한 대상)만 허용하고, 그 외는 사유를 들어 거부한다'],
    ['public/js/finder.js', '그림 삽입 위임: 고른 그림을 바인딩 deliver로 서면에'],
    ['public/js/finder.js', '실패하면 서면에 보내지 않는다 — 삽입 쪽은 답이'],
    ['public/js/finder.js', '없는 것을 취소로 안다.'],
    ['public/js/finder.js', '비서 도구 브리지·노멀 표면은 현재 폴더 조회·목록 새로고침을 내다'],
    ['public/js/finder.js', '창 바 두 호스트: 채워진 뒤의 창 바 컨트롤의 동작 위임'],
  ]

  it.each(PINS)('%s에 복원 문장이 있다: %s', (rel, sentence) => {
    expect(read(rel)).toContain(sentence)
  })
})

describe('S5-5 후속 — 깨진 토큰 재발 방지 (전수 소멸 확인)', () => {
  // 후속 패스 11개 파일에서 전수 0건이 된 토큰들. 범위 밖 잔여(다이얼로·
  // 합체 프레임·주소으로·대관)는 여기서 단언하지 않는다 (설계 노트 참조).
  // 'eady'·'xec'는 'ready'·'exec'의 부분 문자열이라 '·eady'·'·xec' 형태로
  // 단언한다.
  const GONE_TOKENS = [
    '위치끈',
    '찓서',
    '삽기',
    '삽치기',
    '덮밥',
    '귀결',
    '무겁게 문제',
    '매니호스트',
    '매니 호스트',
    '다운스트림 합치',
    '형식 보조 모듈',
    '서면한다',
    '두요상를',
    '넣소',
    '플러그 모듈',
    '감시의전체',
    '의본문폰트',
    '정보대조',
    '카탈)로그',
    '바이 너리',
    '페 이지',
    '몸의 본문',
    '자산 상한',
    '진입 자산',
    '리본 서면',
    '때만 찾아보기',
    '그밖에는',
    '캐시 파일명',
    '·eady',
    '·xec',
  ]

  it.each(FOLLOWUP_FILES)('%s에 깨진 토큰이 없다', (rel) => {
    const src = read(rel)
    const found = GONE_TOKENS.filter((t) => src.includes(t))
    expect(found).toEqual([])
  })
})

describe('S5-5 후속 — 서면 잔존 허용 목록 (4곳만)', () => {
  // '서면'이 남는 곳은 복원 불가·의미 선택으로 확정한 4곳뿐이다.
  const ALLOWED: Array<[string, number]> = [
    ['public/js/finder.js', 2959],
    ['public/js/finder.js', 2983],
    ['public/js/finder-deckcraft.js', 437],
    ['public/js/finder-pdf-ops.js', 5],
  ]

  it('후속 패스 11개 파일의 서면은 허용 목록 4곳과 정확히 일치한다', () => {
    const found: Array<[string, number]> = []
    for (const rel of FOLLOWUP_FILES) {
      const lines = read(rel).split('\n')
      lines.forEach((line, idx) => {
        if (line.includes('서면')) found.push([rel, idx + 1])
      })
    }
    const byFileLine = (a: [string, number], b: [string, number]) =>
      a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1
    expect(found.sort(byFileLine)).toEqual([...ALLOWED].sort(byFileLine))
  })
})

describe('S5-5 후속 — 헤더 재작성 핀 (코드 사실 기반)', () => {
  it('finder-format-sheet.js 헤더가 폴백 계약을 올바르게 서술한다', () => {
    const src = read('public/js/finder-format-sheet.js')
    expect(src).toContain('파인더 뷰어 포맷 모듈 — 시트')
    expect(src).toContain('FortuneSheet 대체 페이지(sheet-fortune.html)로')
    expect(src).toContain('손실 고지: 열기 전에 zip 항목을 검사해 차트·이미지가 있으면')
    expect(src).toContain('상단 배너에 알리고, 매크로가 있으면 기본 보기 전용으로 연다.')
    expect(src).toContain('크롬 동기화: 접기 상태(folded)를 엔진 iframe에 myhub-sheet:chrome으로')
    expect(src).toContain('xls: 구형 BIFF는 ExcelJS가 읽지 못해 기존 SheetJS 전용 보기 경로를')
  })

  it('sheet-gridcraft.js 헤더가 이중 프로토콜·폰트 규칙을 서술한다', () => {
    const src = read('public/js/sheet-gridcraft.js')
    expect(src).toContain('안쪽 GridCraft iframe와 gridcraft:* 프로토콜로 말한다')
    expect(src).toContain('비서 연산(myhub-sheet:ops)은 GridCraft 엔진 명령(cell.set 등)으로')
    expect(src).toContain("폰트: Drive '폰트' 폴더의 파일을 gridcraft:fonts로 받아서 넣는다.")
    expect(src).toContain('Drive 폰트가 풀과 같은 페이스를')
  })

  it('fonts.js 폰트 풀 bullet이 풀 구성을 올바르게 서술한다', () => {
    const src = read('public/js/fonts.js')
    expect(src).toContain('Inter 400/500/600/700 + Italic 400 — 본문 폰트')
    expect(src).toContain('매니페스트의 SHA-256과 일치함을 확인한다 (2026-11-05)')
    expect(src).toContain('JetBrains Mono 400, Dancing Script 400 — PdfCraft 내장분.')
    expect(src).toContain('BIZ UDPGothic 400 — DeckCraft craft-fonts 카탈로그의 일본어')
    expect(src).toContain('NanumGothic 400/700 — 한글 대체 폰트')
    expect(src).toContain('라이선스 텍스트는 각 폰트 풀 *-OFL.txt가 제공한다.')
    expect(src).toContain('순서: 라틴 전용 폰트를 한글 폰트보다 앞에 넣는다')
  })
})

describe('S5-5 후속 — 부모 확인 사용자-facing 복원 (전사본 바이트 확정)', () => {
  it("손실 배너에 '차트'가 뜬다 (xl/charts/ 감지 — 전사본 바이트 MATCH)", () => {
    const src = read('public/js/finder-format-sheet.js')
    expect(src).toContain("losses.push('차트')")
    expect(src).not.toContain('李⑦듃')
  })

  it('매크로 보기 전용 문구가 "매크로"다 (xl/vbaproject.bin 감지 — 전사본에 매크로 1건·마크다운 0건)', () => {
    const src = read('public/js/finder-format-sheet.js')
    expect(src).not.toContain('마크다운')
    const status = src.match(/매크로가 있는 보기 전용입니다/g) || []
    expect(status.length).toBe(2)
    expect(src).toContain('매크로가 있는 파일 등 편집기에서 보기 전용으로 대변한다')
  })
})
