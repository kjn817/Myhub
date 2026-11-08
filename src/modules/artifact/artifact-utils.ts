/**
 * 아티팩트 모듈 공용 유틸.
 */

/** SHA-256 해시 (Web Crypto) */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
