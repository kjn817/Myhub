/// <reference types="jest" />
/**
 * 보안엔진 적대적 누출 사냥 (2026-11-09).
 *
 * 성질: 어떤 출구(토큰화·플레이스홀더 마스킹·레거시 마스킹·검색 가드·
 * 한국어 게이트)를 통과한 결과에도 원본 비밀의 부분 문자열(4자 이상)이
 * 남아 있으면 실패한다. 표 스캔은 좌표 성질까지 본다 — text.slice(start,
 * end)가 원본 셀의 비밀 영역 전체와 정확히 같아야 한다 (한 글자라도
 * 짧으면 그 글자가 평문으로 나간다).
 *
 * 카나리아: 각 수정 지점의 검사를 되돌리면 해당 케이스가 실패한다
 * (privacy-leak-hunt.md의 카나리아 기록 참조).
 */
import { scan } from '../../src/services/privacy-engine'
import { TokenVault } from '../../src/services/privacy-engine'
import { scanTablePasswords } from '../../src/services/privacy-table-scan'
import { maskForExternalEgress } from '../../src/services/privacy-mask'
import { maskSecrets } from '../../src/services/secret-mask'
import { inspectEgress, inspectEgressKorean } from '../../src/services/privacy-gateway'
import type { ClefInvoke } from '../../src/services/privacy-korean-clef'

const viaVault = (text: string): string => new TokenVault().sanitize(text).text
const viaMask = (text: string): string => maskForExternalEgress(text)
const viaLegacy = (text: string): string => maskSecrets(text).masked

/** 비밀의 길이 4 부분 문자열이 결과에 남아 있으면 그 부분 문자열을 돌려준다. */
function findLeak(masked: string, secret: string): string | null {
  const n = Math.min(4, secret.length)
  if (n === 0) return null
  for (let i = 0; i + n <= secret.length; i++) {
    const sub = secret.slice(i, i + n)
    if (masked.includes(sub)) return sub
  }
  return null
}

function expectClean(label: string, masked: string, secret: string): void {
  const leak = findLeak(masked, secret)
  if (leak !== null) {
    throw new Error(`${label}: 비밀 부분 문자열 '${leak}' (비밀 '${secret}')가 마스킹 결과에 남음: ${masked}`)
  }
}

const tableSlices = (text: string): string[] => scanTablePasswords(text).map((s) => text.slice(s.start, s.end))

describe('표 스캔 — 좌표·형식 변형', () => {
  test('이스케이프가 여러 개 + 구분자가 따옴표 셀 안에 있는 경우에도 구간이 원본 전체를 덮는다', () => {
    const text = '이름,비밀번호\n김철수,"se,c""ret99"'
    expect(tableSlices(text)).toEqual(['se,c""ret99'])
    expectClean('vault', viaVault(text), 'se,c"ret99')
  })

  test('이스케이프 쌍으로 시작하는 따옴표 셀', () => {
    const text = '이름,비밀번호\n김철수,"""sec9ret"'
    expect(tableSlices(text)).toEqual(['""sec9ret'])
  })

  test('이스케이프 쌍으로 끝나는 따옴표 셀', () => {
    const text = '이름,비밀번호\n김철수,"sec9ret"""'
    expect(tableSlices(text)).toEqual(['sec9ret""'])
  })

  test('따옴표 셀 안쪽 앞뒤 공백 + 이스케이프', () => {
    const text = '이름,비밀번호\n김철수,"  sec""ret123  "'
    expect(tableSlices(text)).toEqual(['sec""ret123'])
  })

  test('CRLF + 이스케이프 조합', () => {
    const text = '이름,비밀번호\r\n김철수,"sec""ret""999"'
    expect(tableSlices(text)).toEqual(['sec""ret""999'])
  })

  test('탭 구분 + 따옴표 셀 안에 탭이 있는 값', () => {
    const text = '이름\t비밀번호\n김철수\t"sec\t9ret123"'
    expect(tableSlices(text)).toEqual(['sec\t9ret123'])
  })

  test('이름 셀에 stray 따옴표가 있어도 열이 밀리지 않는다', () => {
    const text = '이름,비밀번호\n김"철수,sec9ret123'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
    expectClean('vault', viaVault(text), 'sec9ret123')
  })

  test('마크다운 표의 비밀번호 열도 스캔된다', () => {
    const text = '| 이름 | 비밀번호 |\n| --- | --- |\n| 김철수 | sec9ret123 |'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
    expectClean('mask', viaMask(text), 'sec9ret123')
  })

  test('세미콜론 구분 표도 스캔된다', () => {
    const text = '이름;비밀번호\n김철수;sec9ret123'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
  })

  test('마크다운 행의 셀 값에 쉼표가 있어도 행이 끊기지 않는다', () => {
    const text = '| 이름 | 비밀번호 |\n| --- | --- |\n| 김,철수 | sec9ret123 |'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
  })

  test('세미콜론 행의 숫자 셀에 쉼표가 있어도 행이 끊기지 않는다', () => {
    const text = '이름;금액;비밀번호\n김철수;1,000;sec9ret123'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
  })

  test('전각 영문 라벨(PASSWORD)도 열로 인정한다', () => {
    const text = '이름,ＰＡＳＳＷＯＲＤ\n김철수,sec9ret123'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
  })

  test('라벨에 제로폭 문자가 끼어도 열로 인정한다', () => {
    const text = '이름,비밀\u200B번호\n김철수,sec9ret123'
    expect(tableSlices(text)).toEqual(['sec9ret123'])
  })
})

describe('비밀번호 문맥 — 값 경계 변형', () => {
  const SECRET = 'sec9ret123'

  test('큰따옴표로 감싼 값', () => {
    expectClean('vault', viaVault(`비밀번호는 "${SECRET}" 입니다`), SECRET)
    expectClean('mask', viaMask(`비밀번호는 "${SECRET}" 입니다`), SECRET)
  })

  test('JSON 형태의 큰따옴표 값', () => {
    expectClean('vault', viaVault(`{"password": "${SECRET}", "user": "kim"}`), SECRET)
    expectClean('vault', viaVault(`{"password":"${SECRET}"}`), SECRET)
  })

  test('작은따옴표로 감싼 값', () => {
    expectClean('vault', viaVault(`비밀번호: '${SECRET}'`), SECRET)
  })

  test('백틱으로 감싼 값', () => {
    expectClean('vault', viaVault('비밀번호는 `' + SECRET + '` 입니다'), SECRET)
  })

  test('라벨 접미사(비밀번호 확인:)가 붙은 경우', () => {
    expectClean('vault', viaVault(`비밀번호 확인: ${SECRET}`), SECRET)
    expectClean('vault', viaVault(`비밀번호 번호는 ${SECRET}`), SECRET)
  })

  test('구어 라벨(비번)도 값 경계로 인정한다', () => {
    expectClean('vault', viaVault(`비번은 ${SECRET}`), SECRET)
    expectClean('vault', viaVault(`비번: ${SECRET}`), SECRET)
  })

  test('공백 분리 비밀번호가 8토큰을 넘어도 전부 덮는다', () => {
    const spaced = 'a1b2 c3d4 e5f6 g7h8 i9j0 k1l2 m3n4 o5p6 q7r8 s9t0'
    const out = viaVault(`비밀번호는 ${spaced}`)
    expectClean('vault', out, 'q7r8')
    expectClean('vault', out, 's9t0')
  })

  test('pw 라벨의 공백 분리 비밀번호도 전부 덮는다', () => {
    const out = viaVault('pw: a1b2 c3d4 e5f6')
    expectClean('vault', out, 'c3d4')
    expectClean('vault', out, 'e5f6')
  })

  test('값이 키워드와 같은 문자열이면 구간이 키워드로 어긋나지 않는다', () => {
    expect(viaVault('password: password')).toBe('password: [PASSWORD_1]')
  })

  test('줄바꿈으로 분리된 공백 비밀번호도 전부 덮는다', () => {
    const out = viaVault('비밀번호는\nsec9 ret123')
    expectClean('vault', out, 'sec9')
    expectClean('vault', out, 'ret123')
    // 토큰 사이에 줄바꿈이 있는 경우
    const out2 = viaVault('비밀번호는 sec9\nret123')
    expectClean('vault', out2, 'sec9')
    expectClean('vault', out2, 'ret123')
  })
})

describe('숫자 비밀 — 구분자·인코딩 변형', () => {
  const CARD = '4111111111111111'

  test('가운데점(·)으로 구분한 카드번호', () => {
    expectClean('vault', viaVault('카드 4111·1111·1111·1111'), CARD)
  })

  test('카드번호 중간에 방향표시 Cf 문자(U+200E)가 끼어도 잡는다', () => {
    expectClean('vault', viaVault('카드 4111\u200E111111111111'), CARD)
  })

  test('카드번호 중간에 변형 선택자(U+FE00)가 끼어도 잡는다', () => {
    expectClean('vault', viaVault('카드 4111\uFE00111111111111'), CARD)
  })

  test('국가코드 +82 휴대전화', () => {
    expectClean('vault', viaVault('연락처 +82 10-1234-5678'), '1012345678')
    expectClean('vault', viaVault('연락처 +82-10-1234-5678'), '1012345678')
    // 점 구분은 정규 규칙이 아니라 접은 숫자 분류 경로로만 잡힌다
    expectClean('vault', viaVault('연락처 +82.10.1234.5678'), '1012345678')
  })

  test('Base64로 인코딩된 API 키도 토큰 전체를 덮는다', () => {
    const key = 'sk-hunt9x8Kq2PvL4mN7sT3wZ6aB'
    const b64 = Buffer.from(key, 'utf8').toString('base64')
    expectClean('vault', viaVault(`토큰 ${b64} 보관`), key)
    // 인코딩된 문자열 자체가 아니라 복호되는 비밀이 기준 — 인코딩 토큰이
    // 그대로 나가면 수신측이 복호할 수 있으므로 토큰도 남아 있으면 안 된다.
    expect(viaVault(`토큰 ${b64} 보관`)).not.toContain(b64)
  })

  test('Base64로 인코딩된 카드번호 (기존 동작 카나리아)', () => {
    const b64 = Buffer.from('4111-1111-1111-1111', 'utf8').toString('base64')
    expect(viaVault(`값 ${b64}`)).not.toContain(b64)
  })

  test('메시지를 나눠 보낸 카드번호 — 5조각 분리', () => {
    const messages = ['카드번호 4111', '1111', '1111 111', '1']
    const r = inspectEgress({ origin: 'hunt', messages: messages.map((content) => ({ role: 'user', content })) })
    const joined = r.messages.map((m) => String(m.content)).join('\n')
    const digitsOnly = joined.replace(/\[CARD_\d+\]/g, '').replace(/\D/g, '')
    expect(digitsOnly.length).toBeLessThan(4)
  })

  test('줄바꿈으로 감긴 API 키도 전부 덮는다', () => {
    const key = 'sk-wrap9x8Kq2PvL4mN7sT3wZ6aB1c'
    const wrapped = 'sk-wrap9x8\nKq2PvL4mN7sT3wZ6aB1c'
    expectClean('vault', viaVault(`키 ${wrapped} 끝`), key)
  })
})

describe('일반 토큰 — 따옴표 값', () => {
  test('JSON의 token 값(큰따옴표)도 덮는다', () => {
    expectClean('vault', viaVault('{"token": "abcd1234efgh5678"}'), 'abcd1234efgh5678')
  })
})

describe('레거시 마스킹(secret-mask 단독 출구)', () => {
  test('Bearer 토큰 뒤에 같은 줄 텍스트가 이어져도 덮는다', () => {
    const out = viaLegacy('Authorization: Bearer abcdef0123456789ABCDEF 추가 텍스트')
    expectClean('legacy', out, 'abcdef0123456789ABCDEF')
  })
})

describe('한국어 게이트 — Clef 경로 후보 상한', () => {
  test('후보가 8개를 넘어도 enforce+Clef에서 전부 토큰화된다', async () => {
    const names = ['김철수', '이영희', '박민준', '최지우', '정하늘', '강도윤', '조서연', '윤아름', '장현우', '임태희']
    const content = names.map((n) => `담당자 ${n}`).join(', ')
    const clef: ClefInvoke = async (req) => {
      const answers: Record<string, unknown> = {}
      for (const k of Object.keys(req.questions)) answers[k] = { type: 'noul', noul: 0.95 }
      return { answers }
    }
    const r = await inspectEgressKorean({
      origin: 'hunt',
      messages: [{ role: 'user', content }],
      mode: 'enforce',
      clefInvoke: clef,
    })
    const out = String(r.messages[0].content)
    for (const n of names) {
      if (out.includes(n)) throw new Error(`Clef 상한 초과 후보가 토큰화되지 않음: ${n} / 출력: ${out}`)
    }
  })
})

describe('스캔 회귀 카나리아 (기존에 잡히던 형태)', () => {
  test('기본 형태들은 계속 잡힌다', () => {
    expect(scan('카드 4111-1111-1111-1111').some((s) => s.type === 'CARD')).toBe(true)
    expect(scan('주민등록번호 900101-1234568').some((s) => s.type === 'RRN')).toBe(true)
    expect(scan('비밀번호는 sec9ret123').some((s) => s.type === 'PASSWORD')).toBe(true)
    expect(scan('키 sk-hunt9x8Kq2PvL4mN7sT3wZ6aB').some((s) => s.type === 'API_KEY')).toBe(true)
    expect(scan('전화 010-1234-5678').some((s) => s.type === 'PHONE_KR')).toBe(true)
    expect(scan('카드 4111111111111111').some((s) => s.type === 'CARD')).toBe(true)
  })
})