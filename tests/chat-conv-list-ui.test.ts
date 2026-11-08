/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 채팅 화면 대화 목록 이어보기 (public/js/chat.js + 실제 chat.html DOM).
 *
 * 검증 성질 (서버 계약 변경의 소비처 회귀 방지):
 * - 초기 로드는 첫 페이지(50건)만 그리고, hasMore면 "더 보기" 버튼이 붙는다
 * - 버튼을 누르면 다음 페이지가 뒤에 누적되고, 마지막 페이지에서 버튼이 사라진다
 * - 목록 항목은 제목 + 40자 미리보기로 표시되고, 클릭하면 그 대화로 전환된다
 *
 * fetch는 페이지네이션 계약을 따르는 가짜 서버로 대체한다 (운영 서버 아님).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const doc: any = (globalThis as any).document
const win: any = (globalThis as any).window
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf-8')
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf-8')

const TOTAL = 120

function fakeServer(url: string): any {
  if (url.startsWith('/api/ai/personas')) {
    return { ok: true, json: async () => [] }
  }
  if (url.startsWith('/api/ai/conversations?')) {
    const u = new URL(url, 'http://test')
    const limit = Number(u.searchParams.get('limit') || '50')
    const offset = Number(u.searchParams.get('offset') || '0')
    const all = Array.from({ length: TOTAL }, (_, i) => ({
      id: TOTAL - i,
      title: `대화 ${TOTAL - i}`,
      updated_at: '2026-10-31T00:00:00.000Z',
      last_msg: '미리보기 본문입니다 '.repeat(10).slice(0, 40),
    }))
    const page = all.slice(offset, offset + limit)
    const hasMore = offset + limit < TOTAL
    return {
      ok: true,
      json: async () => ({
        ok: true, conversations: page, hasMore,
        limit, offset, nextOffset: hasMore ? offset + limit : null,
      }),
    }
  }
  if (url.startsWith('/api/ai/room-history')) {
    return { ok: true, json: async () => ({ ok: true, messages: [], hasMore: false }) }
  }
  if (url.startsWith('/api/ai/feedback/')) {
    return { ok: true, json: async () => ({ ok: true, feedback: null }) }
  }
  return { ok: true, json: async () => ({ ok: true }) }
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('chat.js 대화 목록 이어보기', () => {
  let requestedUrls: string[]

  beforeEach(async () => {
    requestedUrls = []
    const bodyHtml = CHAT_HTML.split('<body>')[1].split('</body>')[0]
    doc.body.innerHTML = bodyHtml
    const fetchStub = async (url: any, _opts?: any) => {
      requestedUrls.push(String(url))
      return fakeServer(String(url))
    }
    const loader = new Function(
      'window', 'document', 'fetch', 'marked', 'DOMPurify', 'hljs', 'confirm',
      CHAT_JS,
    )
    loader(
      win, doc, fetchStub,
      { setOptions: () => {}, parse: (t: string) => t },
      { sanitize: (t: string) => t },
      { highlightElement: () => {} },
      () => true,
    )
    await flush()
  })

  test('초기 로드: 50건 + 더 보기 버튼, 첫 요청은 limit=50&offset=0', () => {
    const items = doc.querySelectorAll('#convList .conv-item')
    expect(items).toHaveLength(50)
    const more = doc.querySelector('#convList .conv-more-btn')
    expect(more).not.toBeNull()
    expect(requestedUrls.some((u) => u.includes('/api/ai/conversations?limit=50&offset=0'))).toBe(true)
    // 제목·미리보기 표시 확인
    expect(items[0].querySelector('.ctitle')?.textContent).toBe('대화 120')
    expect(items[0].querySelector('.cpreview')?.textContent?.length).toBeLessThanOrEqual(40)
  })

  test('더 보기 2회로 전체 120건 도달, 버튼 소멸, 중복 없음', async () => {
    const clickMore = async () => {
      const more = doc.querySelector('#convList .conv-more-btn') as any
      expect(more).not.toBeNull()
      more!.click()
      await flush()
    }
    await clickMore()
    expect(doc.querySelectorAll('#convList .conv-item')).toHaveLength(100)
    await clickMore()
    const items = doc.querySelectorAll('#convList .conv-item')
    expect(items).toHaveLength(TOTAL)
    expect(doc.querySelector('#convList .conv-more-btn')).toBeNull()
    const titles = Array.from(items).map((el) => el.querySelector('.ctitle')?.textContent)
    expect(new Set(titles).size).toBe(TOTAL)
    expect(titles[0]).toBe('대화 120')
    expect(titles[TOTAL - 1]).toBe('대화 1')
  })

  test('항목 클릭 시 그 대화의 room-history를 불러온다 (대화 열기 회귀)', async () => {
    requestedUrls = []
    const first = doc.querySelector('#convList .conv-item') as any
    first.click()
    await flush()
    expect(requestedUrls.some((u) => u.includes('/api/ai/room-history') && u.includes('conversationId=120'))).toBe(true)
  })
})
