/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 5-4 F-L3 유틸 통합 — 소비처 구조 테스트.
 *
 * 고정하는 성질:
 * - 5개 소비처(memo/utils·schedule·todo·trace·chat)에 로컬 esc·
 *   friendlyError·escapeHtml 정의가 없고 코어 별칭만 남았다.
 * - 5개 HTML에서 코어 태그가 소비처 태그보다 먼저 온다 (정적 순서).
 * - 코어 없으면 소비처는 로드 시점에 명확한 오류를 낸다 (조용히
 *   건너뛰지 않는다 — 이스케이프는 생략 불가).
 * - memo-bundle.js도 같은 상태다 (소스-번들 동기).
 * - fmtSize/fmtDate는 통합 대상이 아니라 그대로 남아 있다.
 * - 코어가 static-assets.json + asset-url.js DYNAMIC_ASSETS에 등록됐다.
 * 카나리아: 소비처에 로컬 정의를 되돌리면 부재 테스트가, HTML 순서를
 * 뒤집으면 순서 테스트가, 코어 태그를 빼면 페이지 로드 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, jsonRes } from '../f2-page-harness'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const W: any = (globalThis as any).window

const CONSUMERS = [
  { file: 'public/js/memo/utils.js', names: ['esc', 'friendlyError'] },
  { file: 'public/js/schedule.js', names: ['esc', 'friendlyError'] },
  { file: 'public/js/todo.js', names: ['esc', 'friendlyError'] },
  { file: 'public/js/trace.js', names: ['esc'] },
  { file: 'public/js/chat.js', names: ['escapeHtml', 'friendlyError'] },
]

const PAGES = [
  { html: 'schedule.html', script: '/js/schedule.js' },
  { html: 'todo.html', script: '/js/todo.js' },
  { html: 'chat.html', script: '/js/chat.js' },
  { html: 'trace.html', script: '/js/trace.js' },
  { html: 'memo.html', script: '/js/memo-bundle.js' },
]

describe('소비처에 로컬 정의가 없고 코어 별칭만 남았다', () => {
  it.each(CONSUMERS)('$file — 로컬 function 정의 없음', ({ file, names }) => {
    const src = read(file)
    for (const name of names) {
      expect(src).not.toMatch(new RegExp(`function\\s+${name}\\s*\\(`))
    }
  })

  it.each(CONSUMERS)('$file — MyHubTextUtils 별칭이 있다', ({ file, names }) => {
    const src = read(file)
    expect(src).toContain('window.MyHubTextUtils')
    for (const name of names) {
      expect(src).toMatch(new RegExp(`\\b${name}\\s*=\\s*textUtils\\.(esc|friendlyError)\\b`))
    }
  })

  it('chat.js의 escapeHtml은 코어 esc의 별칭이다 (이름 유지, 호출처 교체 없음)', () => {
    const src = read('public/js/chat.js')
    expect(src).toContain('const escapeHtml = textUtils.esc;')
    // 호출처는 20곳 이상 그대로 — 별칭 교체만으로 동작한다
    const calls = src.match(/escapeHtml\(/g) || []
    expect(calls.length).toBeGreaterThan(20)
  })
})

describe('HTML 정적 태그 순서 — 코어가 소비처보다 먼저 온다', () => {
  it.each(PAGES)('$html — text-utils 태그가 $script보다 앞선다', ({ html, script }) => {
    const doc = read(`public/${html}`)
    const coreIdx = doc.indexOf('<script src="/js/common/text-utils.js"></script>')
    const consumerIdx = doc.indexOf(`<script src="${script}"></script>`)
    expect(coreIdx).toBeGreaterThan(-1)
    expect(consumerIdx).toBeGreaterThan(-1)
    expect(coreIdx).toBeLessThan(consumerIdx)
  })

  it('finder.html·desktop.html에는 코어 태그가 없다 (esc/friendlyError 소비처 없음)', () => {
    expect(read('public/finder.html')).not.toContain('/js/common/text-utils.js')
    expect(read('public/desktop.html')).not.toContain('/js/common/text-utils.js')
  })
})

describe('코어 없으면 소비처가 로드 시점에 명확한 오류를 낸다', () => {
  it.each([
    ['public/js/trace.js', 'trace.js'],
    ['public/js/memo/utils.js', 'memo/utils.js'],
    ['public/js/schedule.js', 'schedule.js'],
    ['public/js/todo.js', 'todo.js'],
  ])('%s 단독 실행 시 text-utils 선행 오류', (rel) => {
    const src = read(rel as string)
    const run = new Function('window', 'document', 'fetch', src)
    expect(() => run({}, {}, async () => ({}))).toThrow(
      'text-utils.js가 먼저 로드되어야 합니다',
    )
  })

  it('chat.js 단독 실행 시 text-utils 선행 오류', () => {
    const src = read('public/js/chat.js')
    const run = new Function('window', 'document', 'fetch', 'marked', 'DOMPurify', 'hljs', 'confirm', src)
    expect(() => run({}, {}, async () => ({}), {}, {}, {}, () => true)).toThrow(
      'text-utils.js가 먼저 로드되어야 합니다',
    )
  })
})

describe('페이지 로드 — 운영과 같은 정적 순서로 코어·소비처가 뜬다', () => {
  // 부팅 fetch 스텁 (f2-chat-ui·f3-page-boot와 같은 계약): 각 페이지는
  // 로드 시점에 목록을 가져오므로 배열·객체 형태를 맞춰 준다.
  const pageHandler = async (url: string) => {
    if (url.startsWith('/api/ai/personas')) return jsonRes([])
    if (url.startsWith('/api/ai/conversations')) {
      return jsonRes({ ok: true, conversations: [], hasMore: false, nextOffset: null })
    }
    if (url.startsWith('/api/ai/room-history')) return jsonRes({ ok: true, messages: [], hasMore: false })
    if (url.startsWith('/api/ai/traces')) return jsonRes({ ok: true, traces: [] })
    if (url.startsWith('/api/todo/list')) return jsonRes({ todos: [] })
    return jsonRes({ ok: true })
  }

  it.each(PAGES)('$html — 코어와 소비처 스크립트 로드 오류 없음', ({ html, script }) => {
    const page = loadPage(html, pageHandler)
    const bad = page.errors.filter(
      (e) => e.script === '/js/common/text-utils.js' || e.script === script,
    )
    expect(bad).toEqual([])
  })

  it('memo.html 로드 후 번들의 esc·friendlyError가 코어 동작을 한다', () => {
    loadPage('memo.html', pageHandler)
    expect(typeof W.esc).toBe('function')
    expect(W.esc(`<a>'&`)).toBe('&lt;a&gt;&#39;&amp;')
    expect(typeof W.friendlyError).toBe('function')
    expect(W.friendlyError('decrypt_failed', '폴백')).toBe('폴백')
    expect(W.friendlyError('일반 문구', '폴백')).toBe('일반 문구')
  })
})

describe('memo-bundle.js 소스-번들 동기', () => {
  it('번들에 로컬 정의가 없고 코어 별칭이 있다', () => {
    const bundle = read('public/js/memo-bundle.js')
    expect(bundle).not.toMatch(/function\s+esc\s*\(/)
    expect(bundle).not.toMatch(/function\s+friendlyError\s*\(/)
    expect(bundle).toContain('window.MyHubTextUtils')
    expect(bundle).toContain('var esc = textUtils.esc;')
    expect(bundle).toContain('var friendlyError = textUtils.friendlyError;')
  })
})

describe('통합 범위 가드 — fmtSize/fmtDate는 손대지 않는다', () => {
  it('memo/utils.js와 번들에 fmtSize·fmtDate가 그대로 있다', () => {
    for (const file of ['public/js/memo/utils.js', 'public/js/memo-bundle.js']) {
      const src = read(file)
      expect(src).toContain('function fmtSize(b)')
      expect(src).toContain('function fmtDate(s)')
    }
  })

  it('finder.js의 fmtSize·fmtDate도 그대로 있다 (동명이의·동작 상이)', () => {
    const src = read('public/js/finder.js')
    expect(src).toContain('function fmtSize(n)')
    expect(src).toContain('function fmtDate(v)')
    expect(src).not.toContain('MyHubTextUtils')
  })
})

describe('코어 등록 — manifest + asset-url', () => {
  it('static-assets.json files에 코어가 있다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/text-utils.js')
  })

  it('asset-url.js DYNAMIC_ASSETS에 코어가 있다', () => {
    expect(read('public/js/asset-url.js')).toContain("'/js/common/text-utils.js'")
  })
})
