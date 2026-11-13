/// <reference types="jest" />
/**
 * src/services/privacy-engine.ts — 탐지·분류·토큰화 성질 테스트.
 *
 * 체크섬(주민·사업자)·Luhn(카드)은 "유효한 번호만 탐지, 한 자리만 틀려도
 * 미탐지"라는 쌍으로 고정한다 — 검증 함수 중 하나라도 느슨해지면 오탐이,
 * 엄격해지면 미탐이 생기는 것을 양방향으로 잡는다. 정규화(NFKC·제로폭
 * 제거)· base64·공백 붕괴·메시지 결합 경로는 우회 차단이 설계 목적이다.
 * 카나리아: rrnChecksumOk의 가중치를 바꾸거나 classifyLevel의 restricted
 * 하한(2)을 내리면 실패한다.
 */
import {
  PrivacyEngineError,
  TokenVault,
  classifyLevel,
  detectCrossMessageSpans,
  detectPii,
  redactStringForLog,
  scan,
} from '../../src/services/privacy-engine'

function typesOf(text: string): string[] {
  return detectPii(text).map((f) => f.type)
}

describe('detectPii — 체크섬·Luhn 검증 쌍', () => {
  test('체크섬이 맞는 주민번호(하이픈형)만 RRN으로 탐지한다', () => {
    expect(typesOf('주민등록번호 900101-1234568')).toContain('RRN')
    expect(typesOf('주민등록번호 900101-1234567')).not.toContain('RRN') // 체크섬 1자리 오류
    expect(typesOf('주민등록번호 900101-1234568')).not.toContain('FOREIGNER_NO')
  })

  test('외국인등록번호(7번째 자리 5~8)는 FOREIGNER_NO로 구분된다', () => {
    const out = typesOf('외국인번호 900101-5234567')
    expect(out).toContain('FOREIGNER_NO')
    expect(out).not.toContain('RRN')
  })

  test('무하이픈 13자리도 체크섬+생년월일이 맞을 때만 탐지한다', () => {
    expect(typesOf('번호 9001011234568')).toContain('RRN')
    expect(typesOf('번호 9001011234567')).not.toContain('RRN')
    // 생년월일 자리(13월)는 체크섬 이전에 걸러진다
    expect(typesOf('번호 9013011234565')).not.toContain('RRN')
  })

  test('사업자번호는 체크섬이 맞아야 탐지한다', () => {
    expect(typesOf('사업자등록번호 123-45-67891')).toContain('BIZ_NO')
    expect(typesOf('사업자등록번호 123-45-67890')).not.toContain('BIZ_NO')
  })

  test('카드는 Luhn이 맞아야 탐지한다', () => {
    expect(typesOf('카드 4111-1111-1111-1111')).toContain('CARD')
    expect(typesOf('카드 4111-1111-1111-1112')).not.toContain('CARD')
    expect(typesOf('카드 4111111111111111')).toContain('CARD')
  })
})

describe('detectPii — 문맥 의존 규칙', () => {
  test('운전면허: 지역형은 단독 탐지, 숫자형은 문맥이 있어야 탐지한다', () => {
    expect(typesOf('면허 서울-11-123456-78')).toContain('DRIVER_LICENSE')
    expect(typesOf('운전면허 번호 11-22-333333-44')).toContain('DRIVER_LICENSE')
    expect(typesOf('주문 코드 11-22-333333-44')).not.toContain('DRIVER_LICENSE')
  })

  test('여권: 문맥이 있을 때만 탐지한다', () => {
    expect(typesOf('여권번호 M12345678')).toContain('PASSPORT')
    expect(typesOf('코드 M12345678')).not.toContain('PASSPORT')
  })

  test('계좌: 하이픈형은 금융 문맥 + 자리수 범위, 무하이픈형은 계좌 명시가 필요하다', () => {
    expect(typesOf('국민은행 계좌 123-456789-012')).toContain('BANK_ACCOUNT')
    expect(typesOf('주문번호 123-456789-012')).not.toContain('BANK_ACCOUNT')
    expect(typesOf('계좌번호 123456789012')).toContain('BANK_ACCOUNT')
    expect(typesOf('번호 123456789012')).not.toContain('BANK_ACCOUNT')
    // 01로 시작하는 무하이픈 숫자는 계좌 문맥이 있어도 계좌로 보지 않는다 (전화 오탐 방지)
    expect(typesOf('계좌번호 01012345678')).not.toContain('BANK_ACCOUNT')
  })

  test('연락처·이메일·키·토큰 기본형', () => {
    expect(typesOf('연락처 010-1234-5678')).toContain('PHONE_KR')
    expect(typesOf('메일 someone@example.com')).toContain('EMAIL')
    expect(typesOf('키 sk-abcdefghijklmnopqrstuvwx')).toContain('API_KEY')
    expect(typesOf('Authorization: Bearer abcdefghijklmnop1234')).toContain('TOKEN')
    expect(typesOf('-----BEGIN PRIVATE KEY-----')).toContain('TOKEN')
    expect(typesOf('api_key = abcd1234efgh5678')).toContain('API_KEY')
  })

  test('비밀번호 문맥의 값은 PASSWORD(L3)로 잡힌다', () => {
    const out = detectPii('비밀번호는 mysecret99 입니다')
    const pw = out.find((f) => f.type === 'PASSWORD')
    expect(pw).toBeDefined()
    expect(pw?.level).toBe(3)
  })
})

describe('scan — 정규화·붕괴·base64 우회 차단', () => {
  test('전각 숫자로 쓴 카드도 탐지하고 구간은 원본 문자열을 가리킨다', () => {
    const text = '카드 ４１１１１１１１１１１１１１１１'
    const spans = scan(text)
    const card = spans.find((s) => s.type === 'CARD')
    expect(card).toBeDefined()
    expect(text.slice(card!.start, card!.end)).toBe('４１１１１１１１１１１１１１１１')
  })

  test('제로폭 문자를 끼운 카드도 탐지한다', () => {
    const text = '4111​111111111111'
    expect(typesOf(text)).toContain('CARD')
  })

  test('공백으로 쪼갠 전화·사업자·계좌도 탐지한다', () => {
    expect(typesOf('연락처 010 1234 5678')).toContain('PHONE_KR')
    expect(typesOf('사업자번호 123 456 7891')).toContain('BIZ_NO')
    expect(typesOf('국민은행 계좌 1234 5678 9012')).toContain('BANK_ACCOUNT')
  })

  test('base64로 인코딩한 카드번호도 탐지한다', () => {
    expect(typesOf('NDExMTExMTExMTExMTExMQ==')).toContain('CARD')
    // 숫자가 아닌 내용을 인코딩한 것은 탐지하지 않는다
    expect(typesOf('aGVsbG8gd29ybGQgaGVsbG8=')).not.toContain('CARD')
    // 디코딩 불가(깨진 UTF-8) 토큰은 건너뛴다
    expect(typesOf('////////////////////')).toEqual([])
  })

  test('scan 결과는 항상 시작 순 정렬 + 비중첩 + value가 원본 구간과 일치한다', () => {
    const corpus = [
      '주민등록번호 900101-1234568, 카드 4111-1111-1111-1111, 메일 a@b.co.kr',
      '비밀번호는 mysecret99, 연락처 010-1234-5678',
      '아무것도 없는 평문',
      '계좌번호 123456789012 그리고 사업자 123-45-67891',
    ]
    for (const text of corpus) {
      const spans = scan(text)
      for (let i = 0; i < spans.length; i++) {
        expect(text.slice(spans[i].start, spans[i].end)).toBe(spans[i].value)
        if (i > 0) {
          expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end)
        }
      }
    }
  })
})

describe('detectPii — 입력 계약', () => {
  test('비문자열 입력은 PrivacyEngineError를 던진다', () => {
    for (const bad of [123, null, undefined, {}, []]) {
      expect(() => detectPii(bad as never)).toThrow(PrivacyEngineError)
    }
  })

  test('반환 finding에는 원본 값(value)이 실리지 않는다', () => {
    const out = detectPii('카드 4111-1111-1111-1111')
    expect(out.length).toBeGreaterThan(0)
    for (const f of out) expect(f).not.toHaveProperty('value')
  })
})

describe('detectCrossMessageSpans — 메시지 결합 탐지', () => {
  test('두 메시지로 쪼개진 카드는 양쪽 구간이 모두 보고된다', () => {
    const out = detectCrossMessageSpans(['카드 앞자리 4111', '뒷자리 111111111111'])
    expect(out).toHaveLength(2)
    expect(out.map((s) => s.messageIndex).sort()).toEqual([0, 1])
    expect(out.every((s) => s.type === 'CARD' && s.level === 2)).toBe(true)
  })

  test('한 메시지 안에 온전한 카드는 결합 탐지의 몫이 아니다', () => {
    expect(detectCrossMessageSpans(['카드 4111111111111111'])).toEqual([])
  })

  test('무관한 프래그먼트 조합은 탐지하지 않는다', () => {
    expect(detectCrossMessageSpans(['hello world', 'foo bar baz'])).toEqual([])
    expect(detectCrossMessageSpans([])).toEqual([])
    expect(detectCrossMessageSpans(['짧은 글', '또 다른 글'])).toEqual([])
  })

  test('비문자열 메시지는 건너뛴다', () => {
    const out = detectCrossMessageSpans(['카드 앞자리 4111', 42 as never, '뒷자리 111111111111'])
    expect(out).toHaveLength(2)
  })
})

describe('classifyLevel — 하한과 병합', () => {
  test('평문은 레벨 0', () => {
    expect(classifyLevel({ text: '오늘 회의는 세 시' })).toEqual({ level: 0, findings: [] })
  })

  test('정책 민감도가 하한을 결정한다', () => {
    expect(classifyLevel({ text: '평문', policySensitivity: 'restricted' }).level).toBe(2)
    expect(classifyLevel({ text: '평문', policySensitivity: 'personal' }).level).toBe(1)
    expect(classifyLevel({ text: '평문', policySensitivity: 'general' }).level).toBe(0)
    expect(classifyLevel({ text: '평문', policySensitivity: 'unknown-x' }).level).toBe(0)
    expect(classifyLevel({ text: '평문', memoDerived: true }).level).toBe(1)
  })

  test('실제 탐지가 하한보다 높으면 탐지 레벨이 이긴다', () => {
    expect(classifyLevel({ text: '비밀번호는 mysecret99', policySensitivity: 'general' }).level).toBe(3)
    expect(classifyLevel({ text: '카드 4111-1111-1111-1111', policySensitivity: 'personal' }).level).toBe(2)
  })

  test('koreanDetect를 켜면 한국어 이름이 context finding으로 병합된다', () => {
    const text = '김정남 부장님이 내일 참석합니다'
    const off = classifyLevel({ text })
    expect(off.findings.some((f) => f.type === 'NAME')).toBe(false)
    const on = classifyLevel({ text, koreanDetect: true })
    const name = on.findings.find((f) => f.type === 'NAME')
    expect(name).toBeDefined()
    expect(name?.source).toBe('context')
    expect(on.level).toBeGreaterThanOrEqual(2)
  })
})

describe('TokenVault — 토큰화와 복원', () => {
  const TEXT = '카드 4111-1111-1111-1111 로 결제하고 메일은 a@b.co.kr 로'

  test('sanitize→desanitize 왕복은 원문을 정확히 복원한다', () => {
    const vault = new TokenVault()
    const { text: masked, findings } = vault.sanitize(TEXT)
    expect(masked).not.toContain('4111-1111-1111-1111')
    expect(masked).toContain('[CARD_1]')
    expect(findings.some((f) => f.type === 'CARD')).toBe(true)
    expect(vault.desanitize(masked)).toBe(TEXT)
  })

  test('같은 값은 같은 토큰으로, 다른 값은 다른 토큰으로 (번호 부여 순서는 성질이 아니다)', () => {
    const vault = new TokenVault()
    const src = '4111-1111-1111-1111 와 4111-1111-1111-1111, 다른 카드 4242-4242-4242-4242'
    const { text } = vault.sanitize(src)
    const tokens = text.match(/\[CARD_\d\]/g) ?? []
    expect(tokens).toHaveLength(3)
    expect(tokens[0]).toBe(tokens[1]) // 같은 값 → 같은 토큰
    expect(tokens[2]).not.toBe(tokens[0]) // 다른 값 → 다른 토큰
    expect(vault.size).toBe(2)
    expect(vault.desanitize(text)).toBe(src) // 번호와 무관하게 복원은 정확하다
  })

  test('이미 토큰화된 텍스트를 다시 sanitize해도 변하지 않는다', () => {
    const vault = new TokenVault()
    const once = vault.sanitize(TEXT).text
    expect(vault.sanitize(once).text).toBe(once)
  })

  test('sanitizeWith는 스캔이 못 잡는 추가 구간(프래그먼트)도 토큰화한다', () => {
    const vault = new TokenVault()
    const text = '앞자리 4111'
    const { text: out } = vault.sanitizeWith(text, [
      { type: 'CARD', level: 2, start: 4, end: 8 },
    ])
    expect(out).toBe('앞자리 [CARD_1]')
    expect(vault.desanitize(out)).toBe(text)
  })

  test('desanitize는 모르는 토큰을 건드리지 않는다', () => {
    const vault = new TokenVault()
    expect(vault.desanitize('[CARD_99] 그대로')).toBe('[CARD_99] 그대로')
  })
})

describe('redactStringForLog', () => {
  test('API 키 원문이 남지 않는다', () => {
    const out = redactStringForLog('호출 실패 key=sk-abcdefghijklmnopqrstuvwx')
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  test('key= 쿼리 파라미터는 [REDACTED]로 바뀐다', () => {
    const out = redactStringForLog('GET https://x.test/?key=plainvalue123&y=1')
    expect(out).toContain('key=[REDACTED]')
    expect(out).not.toContain('plainvalue123')
  })

  test('maxLen으로 절단되고, 비문자열 입력도 throw하지 않는다', () => {
    expect(redactStringForLog('가'.repeat(100), 10)).toHaveLength(10)
    expect(redactStringForLog(null)).toBe('')
    expect(redactStringForLog(undefined)).toBe('')
    expect(redactStringForLog(12345)).toBe('12345')
  })
})
