/// <reference types="jest" />
/**
 * src/modules/auth/primitives.ts — __Host- 세션 쿠키 헬퍼 성질 테스트.
 *
 * 고정하는 성질:
 * - readSessionToken은 새 이름(__Host-myhub_session)을 먼저 보고, 없으면
 *   구 이름(myhub_session)을 본다. 새 쿠키만 있을 때 구 이름의 부분
 *   문자열 매칭으로 오인하지 않는다 (경계 매칭).
 * - sessionSetCookieValue는 __Host- 이름에 Secure·HttpOnly·SameSite=Lax·
 *   Path=/를 싣고 Domain을 절대 붙이지 않는다 (접두사 규칙 위반 시
 *   브라우저가 쿠키를 조용히 버린다).
 * - setSessionCookie는 새 쿠키 설정 + 구 쿠키 삭제를 두 Set-Cookie로 낸다.
 * - clearSessionCookies는 새·구 이름 둘 다 삭제한다.
 *
 * 카나리아: 쿠키 이름을 구 이름으로 되돌리면 __Host- 단언이 실패하고,
 * 경계 매칭을 빼면 새 쿠키 오인 테스트가 실패한다.
 */
import {
  SESSION_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  readSessionToken,
  sessionSetCookieValue,
  setSessionCookie,
  clearSessionCookies,
} from '../../src/modules/auth/primitives'

describe('세션 쿠키 이름', () => {
  test('새 이름은 __Host- 접두사이고 구 이름은 접두사가 없다', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-myhub_session')
    expect(LEGACY_SESSION_COOKIE_NAME).toBe('myhub_session')
  })
})

describe('readSessionToken', () => {
  test('새 이름만 있으면 legacy=false로 읽는다', () => {
    expect(readSessionToken('__Host-myhub_session=tok123')).toEqual({ token: 'tok123', legacy: false })
  })

  test('구 이름만 있으면 legacy=true로 읽는다', () => {
    expect(readSessionToken('myhub_session=tok123')).toEqual({ token: 'tok123', legacy: true })
  })

  test('둘 다 있으면 새 이름을 우선한다', () => {
    expect(readSessionToken('myhub_session=old; __Host-myhub_session=new')).toEqual({
      token: 'new',
      legacy: false,
    })
  })

  test('새 쿠키만 있을 때 구 이름으로 오인하지 않는다 (부분 문자열 함정)', () => {
    // 경계 없는 /myhub_session=/ 매칭은 '__Host-myhub_session=' 안의
    // 부분 문자열을 잡아 새 토큰을 구 토큰으로 오인한다.
    const r = readSessionToken('__Host-myhub_session=tok123')
    expect(r).toEqual({ token: 'tok123', legacy: false })
  })

  test('다른 쿠키가 섞여 있어도 찾는다', () => {
    expect(readSessionToken('a=1; myhub_session=tok; b=2')).toEqual({ token: 'tok', legacy: true })
    expect(readSessionToken('a=1; __Host-myhub_session=tok; b=2')).toEqual({ token: 'tok', legacy: false })
  })

  test('세션 쿠키가 없으면 null이다', () => {
    expect(readSessionToken('')).toBeNull()
    expect(readSessionToken('a=1; b=2')).toBeNull()
    expect(readSessionToken('myhub_sessionx=tok')).toBeNull()
  })
})

describe('sessionSetCookieValue', () => {
  test('__Host- 규칙을 만족한다: Secure·Path=/·Domain 없음', () => {
    const v = sessionSetCookieValue('tok123')
    expect(v.startsWith('__Host-myhub_session=tok123;')).toBe(true)
    expect(v).toContain('Secure')
    expect(v).toContain('HttpOnly')
    expect(v).toContain('SameSite=Lax')
    expect(v).toContain('Path=/')
    expect(v).not.toContain('Domain=')
    expect(v).toContain('Max-Age=2592000')
  })
})

describe('setSessionCookie / clearSessionCookies', () => {
  function collector() {
    const values: Array<{ name: string; value: string; append?: boolean }> = []
    const c = {
      header(name: string, value: string, opts?: { append?: boolean }) {
        values.push({ name, value, append: opts?.append })
      },
    }
    return { c, values }
  }

  test('발급 시 새 쿠키 설정 + 구 쿠키 삭제를 두 헤더로 낸다', () => {
    const { c, values } = collector()
    setSessionCookie(c, 'tok123')
    expect(values).toHaveLength(2)
    expect(values[0].name).toBe('Set-Cookie')
    expect(values[0].value).toContain('__Host-myhub_session=tok123')
    expect(values[0].append).toBeUndefined()
    expect(values[1].name).toBe('Set-Cookie')
    expect(values[1].value).toBe('myhub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    expect(values[1].append).toBe(true)
  })

  test('삭제 시 새·구 이름 둘 다 Max-Age=0으로 지운다', () => {
    const { c, values } = collector()
    clearSessionCookies(c)
    expect(values).toHaveLength(2)
    expect(values[0].value).toContain('__Host-myhub_session=;')
    expect(values[0].value).toContain('Max-Age=0')
    expect(values[1].value).toContain('myhub_session=;')
    expect(values[1].value).toContain('Max-Age=0')
    expect(values[1].append).toBe(true)
  })
})
