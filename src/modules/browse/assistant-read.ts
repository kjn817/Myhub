/**
 * 비서용 페이지 읽기 — [PAGE:] 마커가 원격 브라우저로 본문을 읽는 경로.
 * SSRF 방어(사설/내부 주소 차단)를 통과한 공개 URL만 연다.
 */

import type { Env } from '../../types'
import { defaultCdpConnect, toDirectCdpWsUrl, type CdpSocket, type CdpConnectFn } from './cdp'
import { ORACLE_CDP_PORT, oracleConfigOf } from './oracle-proxy'

export type PageReadError =
  | 'invalid_url' | 'blocked_host' | 'not_configured' | 'upstream'
  | 'connect' | 'navigate' | 'extract' | 'empty' | 'timeout'

export type PageReadResult =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; error: PageReadError }

const MAX_PAGE_TEXT_CHARS = 12000
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

// ---------------- DNS 리바인딩 방어 (DoH) ----------------
// 동기 validatePublicUrl은 호스트명 문자열만 보므로, 사설 IP로 해석되는
// 호스트명(공격자 도메인·리바인딩)을 못 막는다. Workers에는 DNS API가
// 없어 Cloudflare DoH JSON API로 해석 IP를 확인한다 (실측 확인됨).
// 잔존 한계(TOCTOU): 이 검사는 Worker 시점의 해석 결과이고, 실제 이동은
// 원격 Chromium이 자기 리졸버로 다시 해석해서 일어난다. 리졸버별로 다른
// 답을 주는 표적 리바인딩까지 막으려면 사용 시점 해석(Chromium 측·
// 이그레스 프록시)이 필요하며, 이 검사는 정적 사설 기록·일반 리바인딩을
// 막는 방어선이다.
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const DOH_TIMEOUT_MS = 5000
const DOH_CNAME_MAX_DEPTH = 3

interface DohAnswer { name?: string; type?: number; data?: string }
interface DohResponse { Status?: number; Answer?: DohAnswer[] }

async function dohLookup(
  host: string,
  type: 1 | 28,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DohAnswer[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`
  const res = await fetchFn(url, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`DoH ${res.status}`)
  const data = (await res.json()) as DohResponse
  return Array.isArray(data?.Answer) ? data.Answer : []
}

/** 호스트명의 A/AAAA 해석 IP 목록. 조회 실패 시 null (fail-closed는 호출자 판정).
 *  A/AAAA 없이 CNAME만 오면 타깃을 따라간다 (깊이 상한·방문 집합으로 루프 차단). */
async function resolveHostIps(
  host: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  depth = 0,
  seen = new Set<string>(),
): Promise<string[] | null> {
  if (depth > DOH_CNAME_MAX_DEPTH || seen.has(host)) return []
  seen.add(host)
  let answers: DohAnswer[]
  try {
    const [a, aaaa] = await Promise.all([
      dohLookup(host, 1, fetchFn, timeoutMs),
      dohLookup(host, 28, fetchFn, timeoutMs),
    ])
    answers = [...a, ...aaaa]
  } catch {
    return null
  }
  const ips: string[] = []
  for (const ans of answers) {
    if ((ans.type === 1 || ans.type === 28) && typeof ans.data === 'string') ips.push(ans.data)
  }
  if (ips.length > 0) return ips
  for (const ans of answers) {
    if (ans.type === 5 && typeof ans.data === 'string') {
      const target = ans.data.replace(/\.$/, '')
      const followed = await resolveHostIps(target, fetchFn, timeoutMs, depth + 1, seen)
      if (followed === null) return null
      ips.push(...followed)
    }
  }
  return ips
}

function ipBlocked(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) return ipv4Blocked(Number(v4[1]), Number(v4[2]), Number(v4[3]))
  return ipv6Blocked(ip)
}

/** 동기 검사 + DoH 해석 IP 검사. 리터럴 IP 호스트는 동기 검사로 충분해
 *  DNS 조회를 건너뛴다. 조회 실패·미해결(NXDOMAIN·빈 응답)은 fail-closed로
 *  차단한다. /navigate 경로(oracle-proxy.ts)도 이 함수를 쓰도록 이관해야
 *  한다 — 해당 파일은 별도 작업 범위로, 여기서는 내보내기만 한다. */
export async function validatePublicUrlAsync(
  raw: unknown,
  fetchFn: typeof fetch = fetch,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: PageReadError }> {
  const base = validatePublicUrl(raw)
  if (!base.ok) return base
  const host = new URL(base.url).hostname.toLowerCase()
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return base
  const ips = await resolveHostIps(host, fetchFn, opts.timeoutMs ?? DOH_TIMEOUT_MS)
  if (ips === null || ips.length === 0) return { ok: false, error: 'blocked_host' }
  for (const ip of ips) {
    if (ipBlocked(ip)) return { ok: false, error: 'blocked_host' }
  }
  return base
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

  // 별도 백그라운드 탭을 만들어 읽는다 — 영구 브라우저는 사용자와
  // 공유되므로 사용자 탭을 납치하면 안 된다. 탭은 finally에서 닫는다.
  const created = await call('Target.createTarget', { url: 'about:blank' })
  const targetId = created.result?.targetId
  if (created.error || created.timedOut || typeof targetId !== 'string' || !targetId) {
    return { ok: false, error: 'connect' }
  }
  try {
    const attach = await call('Target.attachToTarget', { targetId, flatten: true })
    const sessionId =
      !attach.error && !attach.timedOut && typeof attach.result?.sessionId === 'string'
        ? attach.result.sessionId
        : null
    if (!sessionId) return { ok: false, error: 'connect' }
    return await readFromSession(call, targetUrl, sessionId, renderDeadlineMs)
  } finally {
    await call('Target.closeTarget', { targetId }).catch(() => ({}))
  }
}

async function readFromSession(
  call: (method: string, params?: Record<string, unknown>, sessionId?: string | null, timeoutMs?: number) => Promise<CdpReply>,
  targetUrl: string,
  sessionId: string,
  renderDeadlineMs: number,
): Promise<PageReadResult> {
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
  const cfg = oracleConfigOf(env)
  if (!cfg) return { ok: false, error: 'not_configured' }
  const fetchFn = deps.fetchFn ?? fetch
  // DNS 리바인딩 방어: 호스트명의 실제 해석 IP까지 확인한다 (fail-closed).
  const dnsChecked = await validatePublicUrlAsync(rawUrl, fetchFn)
  if (!dnsChecked.ok) return { ok: false, error: dnsChecked.error }
  const targetUrl = dnsChecked.url
  const connect = deps.connect ?? defaultCdpConnect
  const secretHeaders = {
    'x-origin-secret': cfg.originSecret,
    'x-cdp-secret': cfg.cdpSecret,
  }
  let version: unknown = null
  try {
    const res = await fetchFn(`https://${cfg.host}:${ORACLE_CDP_PORT}/json/version`, {
      headers: secretHeaders,
    })
    if (!res.ok) return { ok: false, error: 'upstream' }
    version = await res.json().catch(() => null)
  } catch {
    return { ok: false, error: 'upstream' }
  }
  const publicWs = (version as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl
  const directWs =
    typeof publicWs === 'string' ? toDirectCdpWsUrl(publicWs, cfg.host, ORACLE_CDP_PORT) : null
  if (!directWs) return { ok: false, error: 'upstream' }
  let socket: CdpSocket | null = null
  try {
    socket = await connect(directWs, secretHeaders)
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
}
