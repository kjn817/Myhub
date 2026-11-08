/**
 * 관문 테스트 6: 인증 미들웨어 경로 처리
 *
 * 결함 (2026-10-16): c.req.path에 쿼리스트링이 포함되면
 * '/login.html?v=xxx'가 allowlist와 매칭되지 않아 리다이렉트 루프 발생.
 *
 * 수정: split('?')[0]으로 쿼리스트링 제거 후 비교.
 */

function isPublicPath(rawPath) {
  const path = rawPath.split('?')[0]
  return path === '/login.html' || path.startsWith('/api/auth/') || path === '/api/health' ||
    path === '/manifest.json' || path === '/icon-192.png' || path === '/icon-512.png' ||
    path === '/wallpaper.webp'
}

describe('관문 6: 인증 미들웨어 경로', () => {
  test('/login.html → 공개', () => {
    expect(isPublicPath('/login.html')).toBe(true)
  })

  test('/login.html?v=xxx → 공개 (쿼리스트링 있어도)', () => {
    expect(isPublicPath('/login.html?v=1c505181')).toBe(true)
  })

  test('/api/auth/request → 공개', () => {
    expect(isPublicPath('/api/auth/request')).toBe(true)
  })

  test('/agent.html → 비공개 (인증 필요)', () => {
    expect(isPublicPath('/agent.html')).toBe(false)
  })

  test('/agent.html?v=1 → 비공개', () => {
    expect(isPublicPath('/agent.html?v=1')).toBe(false)
  })

  test('/api/ai/chat → 비공개', () => {
    expect(isPublicPath('/api/ai/chat')).toBe(false)
  })
})
