/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F2 프론트엔드 복구 테스트 (2026-11-07) — 운영 QA 실패 4건의 프론트 측 고정.
 *
 * 하네스 원칙: 페이지를 운영과 같은 조건으로 실행한다.
 * - 외부 출처(CDN) 스크립트는 로드하지 않는다 (enforce CSP 페이지에서는
 *   브라우저가 실제로 차단하고, agent.html은 CodeMirror 전역만 스텁으로 대체).
 * - 로컬·인라인 스크립트는 HTML 선언 순서대로 실제 내용을 평가한다.
 * 따라서 chat.html에 CDN 참조가 되돌아오면 marked가 없어 chat.js가
 * ReferenceError로 죽고 이 테스트가 실패한다 (카나리아).
 * (jsdom은 직접 import하면 ESM 로딩에 걸리므로 jest-environment-jsdom 경유로 쓴다.)
 */
import * as fs from 'fs'
import * as path from 'path'

const PUB = path.resolve(__dirname, '..', 'public')
export { PUB }
const W: any = (globalThis as any).window
const DOC: any = (globalThis as any).document

export interface FetchCall { method: string; url: string; body?: string }
export type Handler = (url: string, init: any) => any

export function jsonRes(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  }
}

export async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}

export interface LoadedPage {
  window: any
  document: any
  calls: FetchCall[]
  errors: { script: string; error: string }[]
  externalSkipped: string[]
}

export function loadPage(htmlFile: string, handler: Handler, globals?: (w: any) => void): LoadedPage {
  const html = fs.readFileSync(path.join(PUB, htmlFile), 'utf8')
  const calls: FetchCall[] = []
  const errors: { script: string; error: string }[] = []
  const externalSkipped: string[] = []

  // 페이지 본문으로 교체 (script 태그는 비활성 노드로만 들어간다 — 실행은 아래에서 수동으로)
  const parsed = new W.DOMParser().parseFromString(html, 'text/html')
  DOC.body.innerHTML = parsed.body.innerHTML

  W.fetch = async (url: any, init: any = {}) => {
    const u = String(url)
    calls.push({ method: (init && init.method) || 'GET', url: u, body: init && init.body })
    const out = await handler(u, init)
    return out ?? jsonRes({ ok: true })
  }
  if (!W.matchMedia) {
    W.matchMedia = (q: string) => ({
      matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    })
  }
  if (!W.ResizeObserver) W.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  if (globals) globals(W)

  // 선언 순서대로: 로컬 src는 파일 내용, 인라인은 본문을 평가. CDN은 건너뜀.
  const tagRe = /<script([^>]*)>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[1]
    const srcMatch = attrs.match(/\bsrc="([^"]+)"/)
    if (srcMatch) {
      const src = srcMatch[1]
      if (/^https?:\/\//.test(src)) { externalSkipped.push(src); continue }
      const file = path.join(PUB, src)
      if (!fs.existsSync(file)) { errors.push({ script: src, error: 'file missing: ' + src }); continue }
      try { W.eval(fs.readFileSync(file, 'utf8')) } catch (e: any) {
        errors.push({ script: src, error: String(e?.message || e).split('\n')[0] })
      }
    } else if (m[2].trim()) {
      try { W.eval(m[2]) } catch (e: any) {
        errors.push({ script: '(inline)', error: String(e?.message || e).split('\n')[0] })
      }
    }
  }
  return { window: W, document: DOC, calls, errors, externalSkipped }
}

