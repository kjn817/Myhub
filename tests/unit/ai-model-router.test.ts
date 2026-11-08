/**
 * src/ai/model-router.ts 단위 테스트
 */
/// <reference types="jest" />
import {
  ModelRouter,
  classifySensitivity,
  resolveSensitivity,
  isVerifiedModel,
  FC_VERIFIED_MODELS,
  type SensitivityLevel,
  type ProviderPolicy,
} from '../../src/ai/model-router'
import type { ProviderId } from '../../src/services/ai'

describe('classifySensitivity', () => {
  test('일반 텍스트 → general', () => {
    expect(classifySensitivity('안녕하세요')).toBe('general')
    expect(classifySensitivity('')).toBe('general')
    expect(classifySensitivity('오늘 날씨 어때?')).toBe('general')
  })

  test('제한 패턴 → restricted', () => {
    // OpenAI 스타일 API 키
    expect(classifySensitivity('내 키는 sk-abcdefghij1234567890XYZ야')).toBe('restricted')
    // Google API 키
    expect(classifySensitivity('AIzaSyDaGmWKa4Js3abcdefghi_jklmnop')).toBe('restricted')
    // Slack 토큰
    expect(classifySensitivity('xoxb-1234-5678-abcdef')).toBe('restricted')
    expect(classifySensitivity('xoxp-token-here')).toBe('restricted')
    expect(classifySensitivity('xoxa-token-here')).toBe('restricted')
    // GitHub 토큰
    expect(classifySensitivity('ghp_abcdefghij1234567890')).toBe('restricted')
    // 카드번호
    expect(classifySensitivity('카드번호 1234-5678-9012-3456')).toBe('restricted')
    expect(classifySensitivity('1234567890123456')).toBe('restricted')
    // 비밀번호 패턴
    expect(classifySensitivity('비밀번호: secret123')).toBe('restricted')
    expect(classifySensitivity('패스워드=abc')).toBe('restricted')
    expect(classifySensitivity('password: hunter2')).toBe('restricted')
    expect(classifySensitivity('PASSWORD = x')).toBe('restricted')
    // api_key 패턴
    expect(classifySensitivity('api_key: xyz')).toBe('restricted')
    expect(classifySensitivity('api-key=xyz')).toBe('restricted')
    expect(classifySensitivity('APIKEY: xyz')).toBe('restricted')
    // secret 패턴
    expect(classifySensitivity('secret: abc')).toBe('restricted')
    expect(classifySensitivity('SECRET=abc')).toBe('restricted')
  })

  test('제한 패턴이 개인 키워드보다 우선', () => {
    expect(classifySensitivity('내 메모에 저장된 sk-abcdefghij1234567890XYZ')).toBe('restricted')
  })

  test('개인 키워드 → personal', () => {
    expect(classifySensitivity('내 메모 찾아줘')).toBe('personal')
    expect(classifySensitivity('기억해줘')).toBe('personal')
    expect(classifySensitivity('내 일정 보여줘')).toBe('personal')
    expect(classifySensitivity('스케줄 확인')).toBe('personal')
    expect(classifySensitivity('할일 목록')).toBe('personal')
    expect(classifySensitivity('할 일 추가')).toBe('personal')
    expect(classifySensitivity('약속 잡아줘')).toBe('personal')
    expect(classifySensitivity('다이어리 써줘')).toBe('personal')
    expect(classifySensitivity('일기 읽어줘')).toBe('personal')
    expect(classifySensitivity('개인 정보야')).toBe('personal')
    expect(classifySensitivity('프라이빗 메모')).toBe('personal')
    expect(classifySensitivity('비밀 노트')).toBe('personal')
  })

  test('대소문자 구분 없이 키워드 매칭', () => {
    // PERSONAL_KEYWORDS는 한글이므로 lowerCase 후에도 동일하게 매칭
    expect(classifySensitivity('메모')).toBe('personal')
    expect(classifySensitivity('МЕМО')).toBe('general') // 키릴 문자 — 매칭 안 됨
  })
})

describe('resolveSensitivity', () => {
  test('일반 텍스트 → general', () => {
    const r = resolveSensitivity({ text: '안녕' })
    expect(r.sensitivity).toBe('general')
    expect(r.reason).toContain('text:general')
  })

  test('제한 텍스트 → restricted', () => {
    const r = resolveSensitivity({ text: 'sk-abcdefghij1234567890XYZ' })
    expect(r.sensitivity).toBe('restricted')
  })

  test('search_memo 도구 있으면 최소 personal', () => {
    const r = resolveSensitivity({ text: '안녕', availableTools: ['search_memo'] })
    expect(r.sensitivity).toBe('personal')
    expect(r.reason).toContain('tool:search_memo→personal')
  })

  test('다른 도구는 상향 안 함', () => {
    const r = resolveSensitivity({ text: '안녕', availableTools: ['create_memo', 'web_search'] })
    expect(r.sensitivity).toBe('general')
    expect(r.reason).not.toContain('tool:')
  })

  test('이력 민감도가 높으면 낮추지 않음', () => {
    const r = resolveSensitivity({ text: '안녕', historySensitivity: 'restricted' })
    expect(r.sensitivity).toBe('restricted')
    expect(r.reason).toContain('history:restricted')
  })

  test('이력 personal + 텍스트 general → personal', () => {
    const r = resolveSensitivity({ text: '안녕', historySensitivity: 'personal' })
    expect(r.sensitivity).toBe('personal')
    expect(r.reason).toContain('history:personal')
  })

  test('이력이 텍스트보다 낮으면 무시 (reason 미포함)', () => {
    const r = resolveSensitivity({ text: 'sk-abcdefghij1234567890XYZ', historySensitivity: 'general' })
    expect(r.sensitivity).toBe('restricted')
    expect(r.reason).not.toContain('history:')
  })

  test('서버 최소 민감도 적용', () => {
    const r = resolveSensitivity({ text: '안녕', minSensitivity: 'personal' })
    expect(r.sensitivity).toBe('personal')
    expect(r.reason).toContain('policy-min:personal')
  })

  test('서버 최소가 텍스트보다 낮으면 reason 미포함', () => {
    const r = resolveSensitivity({ text: '내 메모', minSensitivity: 'general' })
    expect(r.sensitivity).toBe('personal')
    expect(r.reason).not.toContain('policy-min:')
  })

  test('복합: 도구 + 이력 + 최소 → 최고값', () => {
    const r = resolveSensitivity({
      text: '안녕',
      availableTools: ['search_memo'],
      historySensitivity: 'restricted',
      minSensitivity: 'personal',
    })
    expect(r.sensitivity).toBe('restricted')
  })

  test('maxSensitivity: undefined 무시', () => {
    const r = resolveSensitivity({ text: '안녕', historySensitivity: undefined, minSensitivity: undefined })
    expect(r.sensitivity).toBe('general')
  })
})

describe('FC_VERIFIED_MODELS', () => {
  test('2개 모델 정의', () => {
    expect(FC_VERIFIED_MODELS).toHaveLength(2)
  })

  test('groq 모델 포함', () => {
    expect(FC_VERIFIED_MODELS[0].provider).toBe('groq')
    expect(FC_VERIFIED_MODELS[0].model).toBe('openai/gpt-oss-120b')
  })

  test('gemini 모델 포함', () => {
    expect(FC_VERIFIED_MODELS[1].provider).toBe('gemini')
    expect(FC_VERIFIED_MODELS[1].model).toBe('gemini-3.5-flash-lite')
  })
})

describe('isVerifiedModel', () => {
  test('검증된 조합 → true', () => {
    expect(isVerifiedModel('groq', 'openai/gpt-oss-120b')).toBe(true)
    expect(isVerifiedModel('gemini', 'gemini-3.5-flash-lite')).toBe(true)
  })

  test('미검증 조합 → false', () => {
    expect(isVerifiedModel('groq', 'other-model')).toBe(false)
    expect(isVerifiedModel('nvidia', 'openai/gpt-oss-120b')).toBe(false)
    expect(isVerifiedModel('gemini', 'gemini-2.0-flash')).toBe(false)
  })
})

describe('프로바이더별 검증 모델 (구 getVerifiedModels — 현행은 FC_VERIFIED_MODELS 필터)', () => {
  // 구 getVerifiedModels(provider) 접근자는 사라졌고, 현행 표면은
  // FC_VERIFIED_MODELS 상수를 provider로 거르는 것이다.
  const byProvider = (provider: string) => FC_VERIFIED_MODELS.filter((m) => m.provider === provider)

  test('groq → 1개', () => {
    const models = byProvider('groq')
    expect(models).toHaveLength(1)
    expect(models[0].model).toBe('openai/gpt-oss-120b')
  })

  test('gemini → 1개', () => {
    const models = byProvider('gemini')
    expect(models).toHaveLength(1)
  })

  test('nvidia → 0개', () => {
    expect(byProvider('nvidia')).toHaveLength(0)
  })

  test('workers-ai → 0개', () => {
    expect(byProvider('workers-ai')).toHaveLength(0)
  })
})

describe('ModelRouter.getPolicy / setPolicy', () => {
  test('기본 정책 조회', () => {
    const router = new ModelRouter()
    const groq = router.getPolicy('groq')
    expect(groq?.status).toBe('verified')
    expect(groq?.allowRestricted).toBe(false)
    const gemini = router.getPolicy('gemini')
    expect(gemini?.viaRelay).toBe(true)
    expect(gemini?.relaySecurityVerified).toBe(false)
  })

  test('모든 provider 정책 존재', () => {
    const router = new ModelRouter()
    for (const p of ['groq', 'gemini', 'nvidia', 'workers-ai'] as ProviderId[]) {
      expect(router.getPolicy(p)).toBeDefined()
    }
  })

  test('setPolicy로 부분 업데이트', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'disabled' })
    expect(router.getPolicy('groq')?.status).toBe('disabled')
    // 다른 필드는 유지
    expect(router.getPolicy('groq')?.allowGeneral).toBe(true)
  })

  test('없는 provider에 setPolicy → 무시', () => {
    const router = new ModelRouter()
    router.setPolicy('unknown' as ProviderId, { status: 'disabled' })
    expect(router.getPolicy('unknown' as ProviderId)).toBeUndefined()
  })

  test('커스텀 정책으로 생성', () => {
    const custom = new Map<ProviderId, ProviderPolicy>()
    custom.set('groq', {
      provider: 'groq',
      status: 'verified',
      allowGeneral: true,
      allowPersonal: false,
      allowRestricted: false,
      viaRelay: false,
      relaySecurityVerified: true,
      dataUse: 'no-train',
    })
    const router = new ModelRouter(custom)
    expect(router.getPolicy('groq')?.allowPersonal).toBe(false)
    expect(router.getPolicy('gemini')).toBeUndefined()
  })
})

describe('ModelRouter.canUseProvider', () => {
  test('알 수 없는 provider → false', () => {
    const router = new ModelRouter()
    const r = router.canUseProvider('unknown' as ProviderId, 'general')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('unknown-provider')
  })

  test('disabled → false', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'disabled' })
    const r = router.canUseProvider('groq', 'general')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('provider-disabled')
  })

  test('unavailable → false', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'unavailable' })
    const r = router.canUseProvider('groq', 'general')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('provider-unavailable')
  })

  test('unverified → false', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'unverified' })
    const r = router.canUseProvider('groq', 'general')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('provider-unverified')
  })

  test('skipStatusCheck=true면 상태 검사 생략', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'disabled' })
    const r = router.canUseProvider('groq', 'general', true)
    expect(r.allowed).toBe(true)
  })

  test('restricted 불허 provider → false', () => {
    const router = new ModelRouter()
    const r = router.canUseProvider('groq', 'restricted')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('restricted-not-allowed')
  })

  test('personal 불허 provider → false', () => {
    const router = new ModelRouter()
    const custom = new Map<ProviderId, ProviderPolicy>()
    custom.set('test' as ProviderId, {
      provider: 'test' as ProviderId,
      status: 'verified',
      allowGeneral: true,
      allowPersonal: false,
      allowRestricted: false,
      viaRelay: false,
      relaySecurityVerified: true,
      dataUse: 'no-train',
    })
    const r2 = new ModelRouter(custom)
    const r = r2.canUseProvider('test' as ProviderId, 'personal')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('personal-not-allowed')
  })

  test('general 불허 provider → false', () => {
    const custom = new Map<ProviderId, ProviderPolicy>()
    custom.set('test' as ProviderId, {
      provider: 'test' as ProviderId,
      status: 'verified',
      allowGeneral: false,
      allowPersonal: false,
      allowRestricted: false,
      viaRelay: false,
      relaySecurityVerified: true,
      dataUse: 'no-train',
    })
    const r2 = new ModelRouter(custom)
    const r = r2.canUseProvider('test' as ProviderId, 'general')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('general-not-allowed')
  })

  test('restricted 허용 provider → true', () => {
    const custom = new Map<ProviderId, ProviderPolicy>()
    custom.set('test' as ProviderId, {
      provider: 'test' as ProviderId,
      status: 'verified',
      allowGeneral: true,
      allowPersonal: true,
      allowRestricted: true,
      viaRelay: false,
      relaySecurityVerified: true,
      dataUse: 'no-train',
    })
    const r2 = new ModelRouter(custom)
    const r = r2.canUseProvider('test' as ProviderId, 'restricted')
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('ok:test')
  })

  test('정상 케이스 → ok', () => {
    const router = new ModelRouter()
    const r = router.canUseProvider('groq', 'general')
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('ok:groq')
  })

  test('personal 허용 확인', () => {
    const router = new ModelRouter()
    expect(router.canUseProvider('groq', 'personal').allowed).toBe(true)
    expect(router.canUseProvider('gemini', 'personal').allowed).toBe(true)
    expect(router.canUseProvider('nvidia', 'personal').allowed).toBe(true)
    expect(router.canUseProvider('workers-ai', 'personal').allowed).toBe(true)
  })
})

describe('ModelRouter.route', () => {
  test('general 요청 → groq 우선 선택', () => {
    const router = new ModelRouter()
    const d = router.route({ text: '안녕', capability: 'chat' })
    expect(d).not.toBeNull()
    // groq: verified(10) + groq(5) + no-relay(3) = 18 (최고)
    expect(d!.provider).toBe('groq')
    expect(d!.model).toBe('openai/gpt-oss-120b')
    expect(d!.reason).toContain('sensitivity:general')
  })

  test('명시적 민감도 사용', () => {
    const router = new ModelRouter()
    const d = router.route({ text: '안녕', capability: 'chat', sensitivity: 'personal' })
    expect(d!.reason).toContain('explicit')
    expect(d!.reason).toContain('sensitivity:personal')
  })

  test('sensitivityContext로 민감도 결정', () => {
    const router = new ModelRouter()
    const d = router.route({
      text: '안녕',
      capability: 'chat',
      sensitivityContext: { availableTools: ['search_memo'] },
    })
    expect(d!.reason).toContain('sensitivity:personal')
    expect(d!.reason).toContain('tool:search_memo')
  })

  test('제한 텍스트 → 후보 없음 → null', () => {
    const router = new ModelRouter()
    const d = router.route({ text: 'sk-abcdefghij1234567890XYZ', capability: 'chat' })
    expect(d).toBeNull()
  })

  test('excludeProviders로 groq 제외 → gemini 선택', () => {
    const router = new ModelRouter()
    const d = router.route({
      text: '안녕',
      capability: 'chat',
      excludeProviders: new Set<ProviderId>(['groq']),
    })
    expect(d!.provider).toBe('gemini')
  })

  test('excludeModels로 모델 제외', () => {
    const router = new ModelRouter()
    const d = router.route({
      text: '안녕',
      capability: 'chat',
      excludeModels: new Set(['openai/gpt-oss-120b']),
    })
    expect(d!.provider).toBe('gemini')
  })

  test('모두 제외 → null', () => {
    const router = new ModelRouter()
    const d = router.route({
      text: '안녕',
      capability: 'chat',
      excludeProviders: new Set<ProviderId>(['groq', 'gemini']),
    })
    expect(d).toBeNull()
  })

  test('정책 변경으로 후보 없음 → null', () => {
    const router = new ModelRouter()
    router.setPolicy('groq', { status: 'disabled' })
    router.setPolicy('gemini', { status: 'disabled' })
    const d = router.route({ text: '안녕', capability: 'chat' })
    expect(d).toBeNull()
  })

  test('reason에 policy-ok 포함', () => {
    const router = new ModelRouter()
    const d = router.route({ text: 'hi', capability: 'chat' })
    expect(d!.reason).toContain('policy-ok:groq')
  })

  test('rank: 정책 없는 provider도 정렬됨 (방어 분기)', () => {
    // FC_VERIFIED_MODELS의 provider가 policies에 없을 때 rank가 0으로 동작
    const empty = new Map<ProviderId, ProviderPolicy>()
    const router = new ModelRouter(empty)
    // canUseProvider에서 unknown-provider로 걸러지므로 null
    const d = router.route({ text: 'hi', capability: 'chat' })
    expect(d).toBeNull()
  })

  test('rank: verified 아닌 정책도 정렬됨', () => {
    const custom = new Map<ProviderId, ProviderPolicy>()
    for (const p of ['groq', 'gemini'] as ProviderId[]) {
      custom.set(p, {
        provider: p,
        status: 'verified',
        allowGeneral: true,
        allowPersonal: true,
        allowRestricted: false,
        viaRelay: p === 'gemini',
        relaySecurityVerified: true,
      dataUse: 'no-train',
      })
    }
    // gemini를 unverified로 바꿔도 route는 groq 선택 (rank 분기 커버)
    custom.get('gemini')!.status = 'unverified'
    const router = new ModelRouter(custom)
    const d = router.route({ text: 'hi', capability: 'chat' })
    expect(d!.provider).toBe('groq')
  })
})

describe('ModelRouter.decideFallback', () => {
  const baseReq = {
    failedProvider: 'groq' as ProviderId,
    failedModel: 'openai/gpt-oss-120b',
    errorCode: 'RATE_LIMITED',
    toolsExecuted: false,
    writeUncertain: false,
    sensitivity: 'general' as SensitivityLevel,
    triedProviders: new Set<ProviderId>(),
    fallbackCount: 0,
  }

  test('정상 fallback → 허용, gemini 후보', () => {
    const router = new ModelRouter()
    const d = router.decideFallback(baseReq)
    expect(d.allowed).toBe(true)
    expect(d.candidate?.provider).toBe('gemini')
    expect(d.reason).toContain('fallback-to:gemini')
  })

  test('fallbackCount >= 1 → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, fallbackCount: 1 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('fallback-limit-exceeded')
    expect(d.candidate).toBeUndefined()
  })

  test('toolsExecuted → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, toolsExecuted: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('tools-already-executed')
  })

  test('writeUncertain → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, writeUncertain: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('write-uncertain')
  })

  test('AUTH_ERROR → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, errorCode: 'AUTH_ERROR' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('auth-error-no-retry')
  })

  test('httpStatus 401 → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, httpStatus: 401 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('auth-error-no-retry')
  })

  test('httpStatus 403 → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, httpStatus: 403 })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('auth-error-no-retry')
  })

  test('httpStatus 500 → 허용 (후보 탐색)', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, httpStatus: 500 })
    expect(d.allowed).toBe(true)
  })

  test('후보 없음 → 거부', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({
      ...baseReq,
      triedProviders: new Set<ProviderId>(['gemini']),
    })
    // groq 실패 + gemini 시도됨 → 후보 없음
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('no-fallback-candidate')
  })

  test('민감도 전달 확인 (restricted → null 후보)', () => {
    const router = new ModelRouter()
    const d = router.decideFallback({ ...baseReq, sensitivity: 'restricted' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('no-fallback-candidate')
  })

  test('triedProviders와 failedProvider 모두 제외', () => {
    const router = new ModelRouter()
    // gemini가 실패했고 groq도 tried → 후보 없음
    const d = router.decideFallback({
      ...baseReq,
      failedProvider: 'gemini',
      failedModel: 'gemini-3.5-flash-lite',
      triedProviders: new Set<ProviderId>(['groq']),
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('no-fallback-candidate')
  })
})
