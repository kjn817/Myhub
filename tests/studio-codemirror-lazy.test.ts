/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, jsonRes, PUB, type Handler } from './f2-page-harness'

/**
 * 스튜디오 CodeMirror 지연 로딩 회귀 (성능 5라운드, 2026-11-13).
 *
 * 배경: agent.html이 CodeMirror 자산 232KB(코어 170KB + 모드 4개 + CSS 2개)를
 * 정적 태그로 받아 페이지 load를 막았다. 실측: Fast 3G에서 스튜디오 로딩
 * 3.4s 중 1.4s가 CodeMirror였다 (차단 프로브). 에디터는 파일 열기 때만
 * 필요하므로 첫 열기 때 loadCodeMirror()가 동적 주입한다.
 *
 * 이 테스트가 검증하는 성질:
 * - agent.html에 CodeMirror 정적 태그가 없다 (load 경로에서 빠짐).
 * - loadCodeMirror()가 CSS 2개 → 코어 → 모드 4개 순서로 주입한다.
 * - 로드 실패 시 promise가 reject되고 다음 호출이 재시도한다.
 * - 로드 완료 뒤 재호출해도 태그가 중복되지 않는다.
 * - CodeMirror 전역이 이미 있으면 주입 없이 즉시 resolve한다.
 *
 * 카나리아: 정적 태그를 되돌리면 정적 테스트가 실패하고, 로더에서 순서
 * await를 빼면 순서 테스트가 실패한다.
 *
 * 주의: 하네스가 jsdom 창을 공유하므로 agent.html은 이 파일에서 한 번만
 * 로드한다. 로더 상태 테스트는 순서에 의존한다 (실패 → 성공 → 중복 방지 →
 * 이미 로드됨) — 순서를 바꾸지 말 것.
 */
const AGENT_HTML = fs.readFileSync(path.join(PUB, 'agent.html'), 'utf-8')
const CM_CSS = ['/vendor/codemirror/codemirror.min.css', '/vendor/codemirror/material.min.css']
const CM_SCRIPTS = [
  '/vendor/codemirror/codemirror.min.js',
  '/vendor/codemirror/xml.min.js',
  '/vendor/codemirror/javascript.min.js',
  '/vendor/codemirror/css.min.js',
  '/vendor/codemirror/htmlmixed.min.js',
]

describe('studio CodeMirror lazy loading (static)', () => {
  test('agent.html에 CodeMirror 정적 script/link 태그가 없다', () => {
    expect(AGENT_HTML).not.toMatch(/<script[^>]*codemirror/i)
    expect(AGENT_HTML).not.toMatch(/<link[^>]*codemirror/i)
  })

  test('로더가 7개 자산을 전부 동적 주입 대상으로 가진다', () => {
    expect(AGENT_HTML).toMatch(/function loadCodeMirror\(\)/)
    for (const asset of [...CM_CSS, ...CM_SCRIPTS]) {
      expect(AGENT_HTML).toContain(asset)
    }
  })

  test('openCodeFile이 에디터 생성 전에 로더를 기다린다', () => {
    const openIdx = AGENT_HTML.indexOf('async function openCodeFile')
    expect(openIdx).toBeGreaterThan(-1)
    const fromTextAreaIdx = AGENT_HTML.indexOf('CodeMirror.fromTextArea', openIdx)
    const awaitIdx = AGENT_HTML.indexOf('await loadCodeMirror()', openIdx)
    expect(awaitIdx).toBeGreaterThan(-1)
    expect(awaitIdx).toBeLessThan(fromTextAreaIdx)
  })
})

describe('studio CodeMirror lazy loading (loader behavior)', () => {
  const handler: Handler = () => jsonRes({ ok: true, data: [] })
  // 동적 import 스텁: 호출 순서와 성공/실패를 테스트가 직접 운전한다.
  // (jsdom은 외부 모듈을 실제로 불러오지 못하므로 window.MyHubModuleImport
  // 주입점을 쓴다 — 실제 import() 동작은 실브라우저 프로브로 검증한다.)
  const importCalls: string[] = []
  type Deferred = { src: string; resolve: () => void; reject: (e: any) => void }
  const pendingImports: Deferred[] = []
  const page = loadPage('agent.html', handler, (w) => {
    w.confirm = () => false
    w.alert = () => {}
    delete (w as any).CodeMirror
    ;(w as any).MyHubModuleImport = (src: string) => {
      importCalls.push(src)
      return new Promise<void>((resolve, reject) => {
        pendingImports.push({ src, resolve, reject })
      })
    }
  })
  const win = page.window as any
  const doc = page.document as any
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const cmLinks = () => Array.from(doc.querySelectorAll('head link[href*="codemirror"]')) as any[]
  const fire = (el: any, type: string) => el.dispatchEvent(new win.Event(type))
  async function driveCssLoad() {
    for (const link of cmLinks()) fire(link, 'load')
    await tick()
  }
  async function driveImport(src: string) {
    const d = pendingImports.find((x) => x.src === src)
    expect(d).toBeTruthy()
    pendingImports.splice(pendingImports.indexOf(d!), 1)
    d!.resolve()
    await tick()
  }

  test('페이지 로드 직후에는 CodeMirror 태그도 전역도 없고 import도 없다', () => {
    expect(doc.querySelectorAll('head script[src*="codemirror"]')).toHaveLength(0)
    expect(cmLinks()).toHaveLength(0)
    expect(importCalls).toHaveLength(0)
    expect(win.CodeMirror).toBeUndefined()
  })

  test('코어 로드 실패 시 reject되고 다음 호출이 재시도한다', async () => {
    const p = win.loadCodeMirror()
    expect(cmLinks().map((l: any) => l.getAttribute('href')).sort()).toEqual([...CM_CSS].sort())
    expect(importCalls).toHaveLength(0)
    await driveCssLoad()
    expect(importCalls).toEqual([CM_SCRIPTS[0]])
    const core = pendingImports.find((x) => x.src === CM_SCRIPTS[0])
    expect(core).toBeTruthy()
    pendingImports.splice(pendingImports.indexOf(core!), 1)
    const rejection = expect(p).rejects.toThrow('코어 로드 실패')
    core!.reject(new Error('코어 로드 실패'))
    await rejection
    // 재시도: 처음부터 다시 import한다 (실패한 시도는 캐시에 남지 않는다).
    const p2 = win.loadCodeMirror()
    expect(cmLinks()).toHaveLength(2)
    await driveCssLoad()
    expect(importCalls).toEqual([CM_SCRIPTS[0], CM_SCRIPTS[0]])
    // 이 재시도는 다음 테스트가 마저 진행한다 — 여기서 resolve까지 몰지 않는다.
    ;(globalThis as any).__cmRetryPromise = p2
  })

  test('재시도한 로더가 순서대로 import하고 resolve한다', async () => {
    const p = (globalThis as any).__cmRetryPromise
    expect(p).toBeTruthy()
    for (const src of CM_SCRIPTS) await driveImport(src)
    await expect(p).resolves.toBeUndefined()
    expect(importCalls).toEqual([CM_SCRIPTS[0], ...CM_SCRIPTS])
    expect(cmLinks()).toHaveLength(2)
  })

  test('로드 완료 뒤 재호출해도 import가 중복되지 않는다', async () => {
    const beforeImports = importCalls.length
    const beforeLinks = cmLinks().length
    await expect(win.loadCodeMirror()).resolves.toBeUndefined()
    expect(importCalls).toHaveLength(beforeImports)
    expect(cmLinks()).toHaveLength(beforeLinks)
  })

  test('CodeMirror 전역이 이미 있으면 import 없이 즉시 resolve한다', async () => {
    win.CodeMirror = { fromTextArea: () => ({}) }
    const beforeImports = importCalls.length
    await expect(win.loadCodeMirror()).resolves.toBeUndefined()
    expect(importCalls).toHaveLength(beforeImports)
    delete win.CodeMirror
  })
})
