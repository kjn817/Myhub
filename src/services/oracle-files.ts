/**
 * 오라클 저장소 파일 클라이언트 (src/services/oracle-files.ts).
 *
 * 하이브리드 저장소(2026-11-19): 10MB를 넘는 브라우저 다운로드는 오라클
 * 서버 /downloads에 그대로 두고 D1에만 등록한다. 이 모듈이 Worker에서
 * 사이드카 CDP 서버(8081)의 /control/file 엔드포인트로 파일을 읽고·
 * 쓰고·지우는 유일한 경로다. drive 라우트와 office 메일 첨부가 함께 쓴다.
 *
 * 인증: x-origin-secret + x-cdp-secret 이중 헤더 (CDP 서버 게이트).
 * 미구성(호스트·시크릿 없음)이면 모든 함수가 null/{ok:false}를 돌려주고
 * 호출자가 502로 매핑한다. LUKS 잠금 사전검사는 하지 않는다 — 잠겼으면
 * 사이드카 읽기가 실패해 같은 502/404로 떨어지고, 에러 메시지는
 * 백엔드명을 노출하지 않아 Finder의 "구분 없음"이 유지된다.
 *
 * 경로는 평탄 파일명만 허용한다 (구분자·`..`·NUL 거부) — Chromium
 * 다운로드는 /downloads 바로 아래 평탄 파일이라 이걸로 충분하고,
 * 경로 순회(path traversal)를 구조적으로 막는다. 사이드카도 같은
 * 검사를 한 번 더 한다 (이중 방어).
 */
import type { Env } from '../types'

export const ORACLE_FILE_PORT = 8081

export interface OracleFileConfig {
  host: string
  originSecret: string
  cdpSecret: string
}

export function oracleFileConfigOf(env: Env): OracleFileConfig | null {
  const host = env.ORACLE_BROWSER_HOST
  const originSecret = env.ORIGIN_SECRET
  const cdpSecret = env.CDP_SECRET
  if (!host || !originSecret || !cdpSecret) return null
  return { host, originSecret, cdpSecret }
}

/** 평탄 파일명인지 검사한다 — `/`·`\`·NUL·`.`·`..`·빈 값·255자 초과 거부. */
export function isFlatFilename(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (!name || name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

function fileUrl(cfg: OracleFileConfig, oraclePath: string): string {
  return `https://${cfg.host}:${ORACLE_FILE_PORT}/control/file?path=${encodeURIComponent(oraclePath)}`
}

function secretHeaders(cfg: OracleFileConfig): Record<string, string> {
  return {
    'x-origin-secret': cfg.originSecret,
    'x-cdp-secret': cfg.cdpSecret,
  }
}

/**
 * 오라클 파일을 스트리밍으로 읽는다. Range를 그대로 전달해 206도 받는다.
 * 미구성·잘못된 경로·네트워크 실패면 null, 그 외에는 상류 응답을 그대로
 * 돌려준다 (호출자가 404/206/200을 구분한다). doFetch는 테스트 주입용 —
 * 기본값은 전역 fetch다.
 */
export async function fetchOracleFile(
  env: Env,
  oraclePath: string,
  range?: string | null,
  doFetch: typeof fetch = fetch,
): Promise<Response | null> {
  const cfg = oracleFileConfigOf(env)
  if (!cfg || !isFlatFilename(oraclePath)) return null
  const headers: Record<string, string> = secretHeaders(cfg)
  if (range) headers['Range'] = range
  try {
    return await doFetch(fileUrl(cfg, oraclePath), { headers })
  } catch {
    return null
  }
}

/**
 * 오라클 파일을 덮어쓴다. 사이드카는 기존 파일만 덮어쓰고 없으면 404를
 * 돌려준다 (고아 파일 생성 방지). 성공 시 {ok:true}, 상류 404면
 * {ok:false, status:404}, 미구성·잘못된 경로·네트워크 실패면
 * {ok:false, status:0}이다.
 */
export async function putOracleFile(
  env: Env,
  oraclePath: string,
  bytes: ArrayBuffer | Uint8Array,
  mime?: string | null,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const cfg = oracleFileConfigOf(env)
  if (!cfg || !isFlatFilename(oraclePath)) return { ok: false, status: 0 }
  const headers: Record<string, string> = secretHeaders(cfg)
  if (mime) headers['content-type'] = mime
  try {
    const res = await doFetch(fileUrl(cfg, oraclePath), {
      method: 'PUT',
      headers,
      body: bytes as BodyInit,
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/**
 * 오라클 파일을 지운다. 멱등이다 — 이미 없어도(상류 404) {ok:true}를
 * 돌려준다. 미구성·잘못된 경로·네트워크 실패만 {ok:false}다.
 */
export async function deleteOracleFile(
  env: Env,
  oraclePath: string,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean }> {
  const cfg = oracleFileConfigOf(env)
  if (!cfg || !isFlatFilename(oraclePath)) return { ok: false }
  try {
    const res = await doFetch(fileUrl(cfg, oraclePath), {
      method: 'DELETE',
      headers: secretHeaders(cfg),
    })
    return { ok: res.ok || res.status === 404 }
  } catch {
    return { ok: false }
  }
}
