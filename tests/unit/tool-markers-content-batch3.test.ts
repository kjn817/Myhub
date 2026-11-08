/// <reference types="jest" />
/**
 * src/modules/ai/tool-markers-content.ts 성질 테스트 (3차 배치).
 * 기존 마커 스위트와 겹치지 않는 경로: 페이지/파일 마커 전체(상한·승인 거부·
 * 블록형·단일 파일 reveal), 메모 쓰기의 원장 미기록 시 "성공 단정 금지"
 * 문구, 이미지 방출 차단, GitHub/DDG 폴백의 URL 정규화.
 * 카나리아: 페이지 상한(MAX 2)을 지우면 3번째 readPage 호출 단언이,
 * 원장 recorded 검사를 지우면 불확실 문구 단언이 실패한다.
 */
import {
  processMediaSearchMarkers,
  processMemoMarkers,
  processPageMarkers,
  processFileSearchMarkers,
  drivePathLabel,
} from '../../src/modules/ai/tool-markers-content'
import { executeMemoSearch, executeMemoCreate, executeMemoUpdate, executeMemoDelete, executeMemoGet } from '../../src/services/memo-tools'
import { externalWebSearch } from '../../src/modules/ai/web-search'
import { guardSearchQuery } from '../../src/services/privacy-gateway'
import { searchGithubRepos } from '../../src/services/github-search'
import { getImageProviderState, decideImageEmission } from '../../src/services/image-gen'
import { readPage } from '../../src/modules/browse/assistant-read'
import { executeFileSearch } from '../../src/modules/drive/search'
import { recordMarkerToolExecution } from '../../src/services/tool-ledger'

jest.mock('../../src/services/memo-tools', () => {
  const actual = jest.requireActual('../../src/services/memo-tools')
  return {
    ...actual,
    executeMemoSearch: jest.fn(),
    executeMemoGet: jest.fn(),
    executeMemoCreate: jest.fn(),
    executeMemoUpdate: jest.fn(),
    executeMemoDelete: jest.fn(),
  }
})
jest.mock('../../src/modules/ai/web-search', () => ({ externalWebSearch: jest.fn() }))
jest.mock('../../src/services/privacy-gateway', () => ({ guardSearchQuery: jest.fn() }))
jest.mock('../../src/services/github-search', () => ({ searchGithubRepos: jest.fn() }))
jest.mock('../../src/services/image-gen', () => ({
  UNKNOWN_IMAGE_STATE: { known: false },
  getImageProviderState: jest.fn(),
  decideImageEmission: jest.fn(),
  logImageUrlIssued: jest.fn(),
  buildPollinationsImageUrl: (p: string) => `https://img.test/${encodeURIComponent(p)}`,
}))
jest.mock('../../src/modules/browse/assistant-read', () => ({ readPage: jest.fn() }))
jest.mock('../../src/modules/drive/search', () => ({ executeFileSearch: jest.fn() }))
jest.mock('../../src/services/tool-ledger', () => ({ recordMarkerToolExecution: jest.fn() }))

const mockSearch = executeMemoSearch as jest.Mock
const mockCreate = executeMemoCreate as jest.Mock
const mockUpdate = executeMemoUpdate as jest.Mock
const mockDelete = executeMemoDelete as jest.Mock
const mockGet = executeMemoGet as jest.Mock
const mockExternal = externalWebSearch as jest.Mock
const mockGuard = guardSearchQuery as jest.Mock
const mockGithub = searchGithubRepos as jest.Mock
const mockImgState = getImageProviderState as jest.Mock
const mockImgDecision = decideImageEmission as jest.Mock
const mockReadPage = readPage as jest.Mock
const mockFileSearch = executeFileSearch as jest.Mock
const mockLedger = recordMarkerToolExecution as jest.Mock

function makeCtx(text: string, over: Partial<any> = {}): any {
  return {
    env: {},
    text,
    images: [],
    uiActions: [],
    dataChanged: false,
    toolResults: [],
    approvalRequests: [],
    searchReplacementSources: [],
    authorizeTool: jest.fn(async () => ({ allowed: true, message: '' })),
    sanitizeInserted: (s: string) => s,
    denyExecution: () => ({ success: false, error: 'denied' }),
    ...over,
  }
}

const realFetch = global.fetch
beforeEach(() => {
  jest.clearAllMocks()
  mockLedger.mockResolvedValue({ recorded: true, ledgerId: 1, runId: 'r', toolCallId: 't' })
  mockGuard.mockImplementation((q: string) => q)
  mockImgState.mockResolvedValue({ known: true })
  mockImgDecision.mockReturnValue({ emit: true })
})
afterEach(() => {
  global.fetch = realFetch
})

describe('processMediaSearchMarkers — 이미지 방출 차단과 빈 프롬프트', () => {
  test('방출이 차단되면 이미지를 만들지 않고 차단 사유 문구로 치환한다', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockImgDecision.mockReturnValue({ emit: false, reason: 'quota_exceeded', message: '오늘 이미지 한도를 다 썼어요' })
    const ctx = makeCtx('그려줘 [IMG: 고양이] 끝')
    await processMediaSearchMarkers(ctx)
    expect(ctx.images).toEqual([])
    expect(ctx.text).toContain('(오늘 이미지 한도를 다 썼어요)')
    expect(ctx.text).not.toContain('[IMG:')
    expect(errSpy).toHaveBeenCalledWith('image_emission_blocked', expect.objectContaining({ reason: 'quota_exceeded' }))
    errSpy.mockRestore()
  })

  test('빈 프롬프트 마커는 조용히 제거되고, 정상 프롬프트는 이미지로 수집된다', async () => {
    const ctx = makeCtx('a [IMG:   ] b [IMG: 바다 풍경] c')
    await processMediaSearchMarkers(ctx)
    expect(ctx.images).toEqual([{ url: 'https://img.test/%EB%B0%94%EB%8B%A4%20%ED%92%8D%EA%B2%BD', prompt: '바다 풍경' }])
    expect(ctx.text).toBe('a  b  c')
  })

  test('이미지 상태 조회가 실패하면 UNKNOWN 상태로 판정해 폴백한다', async () => {
    mockImgState.mockRejectedValue(new Error('db down'))
    const ctx = makeCtx('[IMG: 산]')
    await processMediaSearchMarkers(ctx)
    expect(mockImgDecision).toHaveBeenCalledWith(expect.objectContaining({ known: false }))
    expect(ctx.images).toHaveLength(1)
  })
})

describe('processMediaSearchMarkers — GitHub 결과 형태', () => {
  test('성공: 필드가 비어 있는 항목도 빈 문자열로 안전하게 렌더링한다', async () => {
    mockGithub.mockResolvedValue({
      ok: true,
      items: [
        { full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 3, description: '설명' },
        { html_url: 'https://github.com/c/d', stargazers_count: 0 },
      ],
    })
    const ctx = makeCtx('[GITHUB: widget]')
    await processMediaSearchMarkers(ctx)
    expect(ctx.text).toContain('GitHub 검색 (widget):')
    expect(ctx.text).toContain('[a/b](https://github.com/a/b) ⭐ 3 - 설명')
    expect(ctx.text).toContain('[](https://github.com/c/d) ⭐ 0 -')
  })

  test('rate_limited와 일반 실패는 서로 다른 안내로 치환한다', async () => {
    mockGithub.mockResolvedValueOnce({ ok: false, reason: 'rate_limited' })
    const ctx1 = makeCtx('[GITHUB: x]')
    await processMediaSearchMarkers(ctx1)
    expect(ctx1.text).toContain('GitHub 검색 실패: x — API 사용량 한도 초과')
    mockGithub.mockResolvedValueOnce({ ok: false, reason: 'network' })
    const ctx2 = makeCtx('[GITHUB: y]')
    await processMediaSearchMarkers(ctx2)
    expect(ctx2.text).toContain('(GitHub 검색 실패: y)')
    expect(ctx2.text).not.toContain('한도 초과')
  })
})

describe('processMediaSearchMarkers — 웹검색 폴백 체인', () => {
  test('외부 검색 성공: 제목이 없는 항목은 URL을 출처 제목으로 쓴다', async () => {
    mockExternal.mockResolvedValue([{ title: '제목1', url: 'https://x.test/1' }, { url: 'https://y.test/2' }])
    const ctx = makeCtx('[SEARCH: 날씨]')
    await processMediaSearchMarkers(ctx)
    expect(ctx.text).toContain('웹검색 (날씨):')
    expect(ctx.text).toContain('[제목1](https://x.test/1)')
    expect(ctx.searchReplacementSources).toEqual([
      { title: '제목1', url: 'https://x.test/1' },
      { title: 'https://y.test/2', url: 'https://y.test/2' },
    ])
  })

  test('외부 검색이 비고 게이트가 쿼리를 막으면 DDG로 내려가지 않는다', async () => {
    mockExternal.mockResolvedValue([])
    mockGuard.mockReturnValue(null)
    global.fetch = jest.fn() as any
    const ctx = makeCtx('[SEARCH: 민감한 쿼리]')
    await processMediaSearchMarkers(ctx)
    expect(ctx.text).toContain('(웹검색 결과 없음: 민감한 쿼리)')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('DDG 폴백: uddg 디코딩·프로토콜 상대 URL 정규화·깨진 인코딩 유지·빈 제목 제외', async () => {
    mockExternal.mockResolvedValue([])
    const html = [
      '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">예제 <b>제목</b></a>',
      '<a class="result__a" href="//cdn.example.org/b">두번째</a>',
      '<a class="result__a" href="https://duckduckgo.com/l/?uddg=%E0%A4%A">깨진 인코딩</a>',
      '<a class="result__a" href="ftp://bad.example/x">나쁜 링크</a>',
      '<a class="result__a" href="https://ok.example/c"></a>',
    ].join('\n')
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => html })) as any
    const ctx = makeCtx('[SEARCH: 폴백]')
    await processMediaSearchMarkers(ctx)
    expect(ctx.text).toContain('[예제 제목](https://example.com/a)')
    expect(ctx.text).toContain('[두번째](https://cdn.example.org/b)')
    expect(ctx.text).toContain('[깨진 인코딩](https://duckduckgo.com/l/?uddg=%E0%A4%A)')
    expect(ctx.text).not.toContain('나쁜 링크')
    expect(ctx.text).not.toContain('ok.example')
    expect(ctx.searchReplacementSources.map((s: any) => s.url)).toEqual([
      'https://example.com/a',
      'https://cdn.example.org/b',
      'https://duckduckgo.com/l/?uddg=%E0%A4%A',
    ])
  })

  test('DDG 응답 실패와 네트워크 예외는 모두 실패 안내로 치환한다', async () => {
    mockExternal.mockResolvedValue([])
    global.fetch = jest.fn(async () => ({ ok: false, text: async () => '' })) as any
    const ctx1 = makeCtx('[SEARCH: q1]')
    await processMediaSearchMarkers(ctx1)
    expect(ctx1.text).toContain('(웹검색 실패: q1)')
    global.fetch = jest.fn(async () => { throw new Error('net down') }) as any
    const ctx2 = makeCtx('[SEARCH: q2]')
    await processMediaSearchMarkers(ctx2)
    expect(ctx2.text).toContain('(웹검색 실패: q2)')
  })

  test('DDG 결과가 0건이면 결과 없음 안내로 치환한다', async () => {
    mockExternal.mockResolvedValue([])
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => '<html>결과 없음</html>' })) as any
    const ctx = makeCtx('[SEARCH: 없는것]')
    await processMediaSearchMarkers(ctx)
    expect(ctx.text).toContain('(웹검색 결과 없음: 없는것)')
  })
})

describe('processMemoMarkers — 승인 거부 전파와 원장 미기록', () => {
  test('MEMO_SEARCH 승인이 거부되면 요청이 전파되고 실행은 일어나지 않는다', async () => {
    const request = { id: 9, tool: 'MEMO_SEARCH' }
    const ctx = makeCtx('[MEMO_SEARCH]{"query":"회의"}[/MEMO_SEARCH]', {
      authorizeTool: jest.fn(async () => ({ allowed: false, message: '승인이 필요해요', request })),
    })
    await processMemoMarkers(ctx)
    expect(ctx.text).toContain('승인이 필요해요')
    expect(ctx.approvalRequests).toEqual([request])
    expect(mockSearch).not.toHaveBeenCalled()
  })

  test('메모 마커와 함께 온 SEARCH 마커는 보안 안내로 차단된다', async () => {
    mockSearch.mockResolvedValue({ success: true, data: [] })
    const ctx = makeCtx('[MEMO_SEARCH]{"query":"회의"}[/MEMO_SEARCH] [SEARCH: 날씨]')
    await processMemoMarkers(ctx)
    expect(ctx.text).toContain('(보안: 메모 조회와 웹검색을 동시에 사용할 수 없습니다)')
    expect(mockExternal).not.toHaveBeenCalled()
  })

  test.each([
    ['생성', '[MEMO_CREATE]{"text":"새 메모"}[/MEMO_CREATE]', () => mockCreate, '메모 생성을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다'],
    ['수정', '[MEMO_UPDATE]{"id":7,"text":"고친 내용"}[/MEMO_UPDATE]', () => mockUpdate, '메모 7 수정을 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다'],
    ['삭제', '[MEMO_DELETE]{"id":8}[/MEMO_DELETE]', () => mockDelete, '메모 8 삭제를 실행했지만 실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다'],
  ])('%s 성공 + 원장 미기록이면 성공으로 단정하지 않는다', async (_name, marker, pick, expected) => {
    pick().mockResolvedValue({ success: true, data: { id: 1 } })
    mockLedger.mockResolvedValue({ recorded: false, ledgerId: null, runId: 'r', toolCallId: 't' })
    const ctx = makeCtx(marker as string)
    await processMemoMarkers(ctx)
    expect(ctx.text).toContain(expected as string)
  })

  test('MEMO_GET 승인 거부가 요청과 함께 전파되고, 성공 시 제목·내용이 삽입 시 정제를 거친다', async () => {
    const request = { id: 3, tool: 'MEMO_GET' }
    const denied = makeCtx('[MEMO_GET]{"id":5}[/MEMO_GET]', {
      authorizeTool: jest.fn(async () => ({ allowed: false, message: '거부됨', request })),
    })
    await processMemoMarkers(denied)
    expect(denied.approvalRequests).toEqual([request])
    expect(mockGet).not.toHaveBeenCalled()

    mockGet.mockResolvedValue({ success: true, data: { title: '<b>제목</b>', content: '본문 <i>내용</i>' } })
    const ok = makeCtx('[MEMO_GET]{"id":5}[/MEMO_GET]', {
      sanitizeInserted: (s: string) => s.replace(/<[^>]+>/g, ''),
    })
    await processMemoMarkers(ok)
    expect(ok.text).toContain('제목: 제목')
    expect(ok.text).toContain('본문 내용')
    expect(ok.text).not.toContain('<b>')
  })
})

describe('processPageMarkers — 상한·승인·성공 형태', () => {
  test('성공: 제목 줄과 절단 고지가 조건부로 붙고 출처가 기록된다', async () => {
    mockReadPage.mockResolvedValue({ ok: true, url: 'https://a.test/p', title: '페이지 제목', text: '본문 텍스트', truncated: true })
    const ctx = makeCtx('읽어줘 [PAGE: https://a.test/p]')
    await processPageMarkers(ctx)
    expect(ctx.text).toContain('웹페이지 본문 (https://a.test/p):\n페이지 제목\n본문 텍스트')
    expect(ctx.text).toContain('(본문이 길어 앞부분만 가져왔습니다)')
    expect(ctx.searchReplacementSources).toEqual([{ title: '페이지 제목', url: 'https://a.test/p' }])
  })

  test('성공: 제목이 없으면 제목 줄이 없고 출처 제목은 URL로 대체된다', async () => {
    mockReadPage.mockResolvedValue({ ok: true, url: 'https://a.test/q', title: '', text: '본문만', truncated: false })
    const ctx = makeCtx('[PAGE]https://a.test/q[/PAGE]')
    await processPageMarkers(ctx)
    expect(ctx.text).toContain('웹페이지 본문 (https://a.test/q):\n본문만')
    expect(ctx.text).not.toContain('앞부분만')
    expect(ctx.searchReplacementSources).toEqual([{ title: 'https://a.test/q', url: 'https://a.test/q' }])
  })

  test('실패: 오류 종류별 한국어 사유가 붙는다', async () => {
    mockReadPage.mockResolvedValue({ ok: false, error: 'blocked_host' })
    const ctx = makeCtx('[PAGE: http://192.168.0.1/]')
    await processPageMarkers(ctx)
    expect(ctx.text).toContain('(페이지 읽기 실패: http://192.168.0.1/ — 내부 주소는 열 수 없습니다)')
    expect(ctx.searchReplacementSources).toEqual([])
  })

  test('승인 거부는 요청을 전파하고 읽기를 시도하지 않는다', async () => {
    const request = { id: 1, tool: 'PAGE' }
    const ctx = makeCtx('[PAGE: https://a.test/]', {
      authorizeTool: jest.fn(async () => ({ allowed: false, message: '승인 필요', request })),
    })
    await processPageMarkers(ctx)
    expect(ctx.text).toContain('승인 필요')
    expect(ctx.approvalRequests).toEqual([request])
    expect(mockReadPage).not.toHaveBeenCalled()
  })

  test('한 번에 최대 2개까지만 읽고 나머지는 상한 안내로 치환한다', async () => {
    mockReadPage.mockResolvedValue({ ok: true, url: 'https://a.test/', title: '', text: '본문', truncated: false })
    const ctx = makeCtx('[PAGE: https://a.test/1] [PAGE: https://a.test/2] [PAGE: https://a.test/3]')
    await processPageMarkers(ctx)
    expect(mockReadPage).toHaveBeenCalledTimes(2)
    expect(ctx.text).toContain('(페이지 읽기는 한 번에 최대 2개까지 가능합니다)')
  })
})

describe('processFileSearchMarkers — 결과 형태와 UI 액션', () => {
  const hit = (over: any = {}) => ({
    success: true,
    data: { folders: [], files: [], total: 0, truncated: false, ...over },
  })

  test('결과 없음은 전용 안내로 치환하고 UI 액션을 만들지 않는다', async () => {
    mockFileSearch.mockResolvedValue(hit())
    const ctx = makeCtx('[FILE_SEARCH: 없는파일]')
    await processFileSearchMarkers(ctx)
    expect(ctx.text).toContain('(파일 검색 결과 없음: "없는파일")')
    expect(ctx.uiActions).toEqual([])
  })

  test('폴더+파일 다건이면 목록을 만들고 finder_search 액션을 낸다 (절단 고지 포함)', async () => {
    mockFileSearch.mockResolvedValue(hit({
      total: 9,
      truncated: true,
      folders: [{ id: 1, name: '문서', path: [{ name: '업무' }] }],
      files: [{ id: 2, folder_id: 1, filename: '보고서.pdf', path: [{ name: '업무' }, { name: '문서' }] }],
    }))
    const ctx = makeCtx('[FILE_SEARCH: 보고서]')
    await processFileSearchMarkers(ctx)
    expect(ctx.text).toContain('파일 검색 (보고서): 9건 중 최근 2건')
    expect(ctx.text).toContain('- [폴더] 문서 — 보관함 › 업무')
    expect(ctx.text).toContain('- 보고서.pdf — 보관함 › 업무 › 문서')
    expect(ctx.uiActions).toEqual([{ uiAction: 'finder_search', query: '보고서' }])
  })

  test('파일이 정확히 1건이면 finder_reveal_file로 그 파일을 드러낸다', async () => {
    const path = [{ name: '업무' }]
    mockFileSearch.mockResolvedValue(hit({
      total: 1,
      files: [{ id: 42, folder_id: 7, filename: '유일.pdf', path }],
    }))
    const ctx = makeCtx('[FILE_SEARCH]유일[/FILE_SEARCH]')
    await processFileSearchMarkers(ctx)
    expect(ctx.uiActions).toEqual([{ uiAction: 'finder_reveal_file', fileId: 42, folderId: 7, path }])
  })

  test('실패와 승인 거부는 실행 없이 안내/요청으로 끝난다', async () => {
    mockFileSearch.mockResolvedValue({ success: false })
    const fail = makeCtx('[FILE_SEARCH: x]')
    await processFileSearchMarkers(fail)
    expect(fail.text).toContain('(파일 검색 실패: x)')

    const request = { id: 2, tool: 'FILE_SEARCH' }
    const denied = makeCtx('[FILE_SEARCH: y]', {
      authorizeTool: jest.fn(async () => ({ allowed: false, message: '노바만 가능', request })),
    })
    await processFileSearchMarkers(denied)
    expect(denied.text).toContain('노바만 가능')
    expect(denied.approvalRequests).toEqual([request])
  })

  test('한 번에 최대 2건까지만 검색하고, 남은 깨진 마커는 실패 안내로 정리한다', async () => {
    mockFileSearch.mockResolvedValue(hit())
    const ctx = makeCtx('[FILE_SEARCH: a] [FILE_SEARCH: b] [FILE_SEARCH: c] [/FILE_SEARCH]')
    await processFileSearchMarkers(ctx)
    expect(mockFileSearch).toHaveBeenCalledTimes(2)
    expect(ctx.text).toContain('(파일 검색은 한 번에 최대 2개까지 가능합니다)')
    expect(ctx.text).toContain('(파일 검색에 실패했습니다)')
    expect(ctx.text).not.toContain('[/FILE_SEARCH]')
  })

  test('drivePathLabel은 보관함에서 시작해 정제된 경로를 잇는다', () => {
    expect(drivePathLabel((s) => s, [])).toBe('보관함')
    expect(drivePathLabel((s) => s.toUpperCase(), [{ name: 'a' }, { name: 'b' }])).toBe('보관함 › A › B')
  })
})
