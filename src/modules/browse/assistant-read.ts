/**
 * 비서용 페이지 읽기 — [PAGE:] 마커가 원격 브라우저로 본문을 읽는 경로.
 * SSRF 방어(사설/내부 주소 차단)를 통과한 공개 URL만 연다.
 */

import type { Env } from '../../types'
import { defaultCdpConnect, type CdpSocket, type CdpConnectFn } from './cdp'
import { CF_BROWSER_URL, findWebSocketDebuggerUrl } from './live'

export type PageReadError =
  | 'invalid_url' | 'blocked_host' | 'not_configured' | 'quota' | 'upstream'
  | 'connect' | 'navigate' | 'extract' | 'empty' | 'timeout'

export type PageReadResult =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; error: PageReadError }

const MAX_PAGE_TEXT_CHARS = 12000
const READ_KEEP_ALIVE_MS = 60000
const DEFAULT_RENDER_DEADLINE_MS = 12000
const CALL_TIMEOUT_MS = 8000
const POLL_INTERVAL_MS = 250

const EXTRACT_EXPRESSION = `(() => {
  var junk = document.querySelectorAll('script, style, noscript, iframe, svg, form, nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]');
  junk.forEach(function (el) { el.remove(); });
  var root = document.querySelector('main, article, [role="main"]') || document.body;
  var text = root ? (root.innerText || '') : '';
  text = text.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title || '', url: location.href, text: text };
})()`

const READYSTATE_EXPRESSION = `JSON.stringify({ rs: document.readyState, href: location.href })`

function ipv4Blocked(a: number, b: number, c: number): boolean {
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function ipv6Blocked(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('::ffff:')) {
    const rest = h.slice('::ffff:'.length)
    if (rest.includes('.')) {
      const p = rest.split('.').map(Number)
      if (p.length === 4) return ipv4Blocked(p[0], p[1], p[2])
      return true
    }
    const groups = rest.split(':')
    if (groups.length === 2) {
      const hi = parseInt(groups[0], 16)
      const lo = parseInt(groups[1], 16)
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return ipv4Blocked(hi >> 8, hi & 255, lo >> 8)
      }
    }
    return true
  }
  const first = h.split(':')[0]
  const head = parseInt(first || '0', 16)
  if (Number.isFinite(head)) {
    if (head >= 65152 && head <= 65215) return true // fe80::/10 링크로컬
    if (head >= 64512 && head <= 65023) return true // fc00::/7 ULA
    if (head >= 65280) return true // ff00::/8 멀티캐스트 등
  }
  return false
}

export function validatePublicUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: PageReadError } {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) {
    return { ok: false, error: 'invalid_url' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'invalid_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'invalid_url' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'invalid_url' }
  }
  const host = parsed.hostname.toLowerCase()
  if (!host) return { ok: false, error: 'invalid_url' }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    return { ok: false, error: 'blocked_host' }
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    if (ipv6Blocked(host.slice(1, -1))) return { ok: false, error: 'blocked_host' }
    return { ok: true, url: parsed.toString() }
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    if (ipv4Blocked(Number(v4[1]), Number(v4[2]), Number(v4[3]))) {
      return { ok: false, error: 'blocked_host' }
    }
  }
  return { ok: true, url: parsed.toString() }
}

interface CdpReply {
  result?: any
  error?: any
  timedOut?: boolean
}

async function readTextWithCdp(
  socket: CdpSocket,
  targetUrl: string,
  opts: { renderDeadlineMs?: number } = {}
): Promise<PageReadResult> {
  const renderDeadlineMs = opts.renderDeadlineMs ?? DEFAULT_RENDER_DEADLINE_MS
  let nextId = 0
  const pending = new Map<number, (reply: CdpReply) => void>()
  socket.addEventListener('message', (ev) => {
    let msg: any
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!
      pending.delete(msg.id)
      resolve({ result: msg.result, error: msg.error })
    }
  })
  const call = (method: string, params?: Record<string, unknown>, sessionId?: string | null, timeoutMs = CALL_TIMEOUT_MS): Promise<CdpReply> =>
    new Promise((resolve) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ timedOut: true })
      }, timeoutMs)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      const msg: Record<string, unknown> = { id, method }
      if (params) msg.params = params
      if (sessionId) msg.sessionId = sessionId
      try {
        socket.send(JSON.stringify(msg))
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        resolve({ error: { message: 'send failed' } })
      }
    })

  let sessionId: string | null = null
  for (let attempt = 0; attempt < 3 && !sessionId; attempt++) {
    const targets = await call('Target.getTargets')
    if (targets.error || targets.timedOut) break
    const infos = targets.result?.targetInfos ?? []
    const page = infos.find((t: any) => t.type === 'page') ?? infos[0]
    if (!page) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      continue
    }
    const attach = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    if (!attach.error && typeof attach.result?.sessionId === 'string') {
      sessionId = attach.result.sessionId
    }
    break
  }
  await call('Page.enable', undefined, sessionId).catch(() => ({}))
  const nav = await call('Page.navigate', { url: targetUrl }, sessionId)
  if (nav.timedOut || nav.error || nav.result?.errorText) {
    return { ok: false, error: 'navigate' }
  }
  const deadline = Date.now() + renderDeadlineMs
  let ready = false
  while (Date.now() < deadline) {
    const state = await call('Runtime.evaluate', {
      expression: READYSTATE_EXPRESSION,
      returnByValue: true,
    }, sessionId, 3000)
    const value = state.result?.result?.value
    if (!state.error && !state.result?.exceptionDetails && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed.rs === 'complete' && parsed.href && parsed.href !== 'about:blank') {
          ready = true
          break
        }
      } catch {
        // 아직 렌더링 중
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  if (!ready) return { ok: false, error: 'timeout' }
  const extracted = await call('Runtime.evaluate', {
    expression: EXTRACT_EXPRESSION,
    returnByValue: true,
  }, sessionId)
  if (extracted.timedOut) return { ok: false, error: 'timeout' }
  if (extracted.error || extracted.result?.exceptionDetails) {
    return { ok: false, error: 'extract' }
  }
  const value = extracted.result?.result?.value
  if (!value || typeof value.text !== 'string') {
    return { ok: false, error: 'extract' }
  }
  const text = value.text.trim()
  if (!text) return { ok: false, error: 'empty' }
  return {
    ok: true,
    url: typeof value.url === 'string' && value.url ? value.url : targetUrl,
    title: typeof value.title === 'string' ? value.title.slice(0, 300) : '',
    text,
    truncated: false, // 절단은 readPage가 상한 기준으로 최종 판정한다
  }
}

export interface ReadPageDeps {
  fetchFn?: typeof fetch
  connect?: CdpConnectFn
}

export async function readPage(
  env: Env,
  rawUrl: unknown,
  deps: ReadPageDeps = {},
  opts: { renderDeadlineMs?: number; maxTextChars?: number } = {}
): Promise<PageReadResult> {
  const validated = validatePublicUrl(rawUrl)
  if (!validated.ok) return { ok: false, error: validated.error }
  const targetUrl = validated.url
  const token = env.BROWSER_RUN_TOKEN
  if (!token) return { ok: false, error: 'not_configured' }
  const fetchFn = deps.fetchFn ?? fetch
  const connect = deps.connect ?? defaultCdpConnect
  const headers = { Authorization: `Bearer ${token}` }
  let data: any = null
  try {
    const res = await fetchFn(`${CF_BROWSER_URL}?keep_alive=${READ_KEEP_ALIVE_MS}&targets=true`, {
      method: 'POST',
      headers,
    })
    if (res.status === 429) return { ok: false, error: 'quota' }
    if (!res.ok) return { ok: false, error: 'upstream' }
    data = await res.json().catch(() => null)
  } catch {
    return { ok: false, error: 'upstream' }
  }
  const sid = data?.sessionId
  if (typeof sid !== 'string' || !sid) return { ok: false, error: 'upstream' }
  try {
    const endpoint = findWebSocketDebuggerUrl(data)
    if (!endpoint) return { ok: false, error: 'upstream' }
    let socket: CdpSocket | null = null
    try {
      socket = await connect(endpoint.url, headers)
    } catch {
      socket = null
    }
    if (!socket) return { ok: false, error: 'connect' }
    try {
      const result = await readTextWithCdp(socket, targetUrl, {
        renderDeadlineMs: opts.renderDeadlineMs,
      })
      if (!result.ok) return result
      const maxTextChars = opts.maxTextChars ?? MAX_PAGE_TEXT_CHARS
      if (result.text.length > maxTextChars) {
        return { ...result, text: result.text.slice(0, maxTextChars), truncated: true }
      }
      return result
    } finally {
      try {
        socket.close()
      } catch {
        // 무시
      }
    }
  } finally {
    try {
      await fetchFn(`${CF_BROWSER_URL}/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
        headers,
      })
    } catch {
      // 세션 정리 실패는 무시
    }
  }
}
