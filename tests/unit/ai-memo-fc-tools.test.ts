/// <reference types="jest" />

import { MEMO_FC_TOOLS, getFCTool, validateFCArgs, prepareToolsFor, normalizeFCToolName, normalizeToolCall, preflightToolCalls, extractEmbeddedToolCalls } from '../../src/ai/memo-fc-tools'

describe('MEMO_FC_TOOLS', () => {
  test('도구 목록이 정의되어 있다', () => {
    expect(MEMO_FC_TOOLS.length).toBeGreaterThan(0)
    for (const tool of MEMO_FC_TOOLS) {
      expect(tool.name).toBeDefined()
      expect(tool.description).toBeDefined()
      expect(tool.parameters.type).toBe('object')
      expect(Array.isArray(tool.parameters.required)).toBe(true)
    }
  })

  test('memo_create 도구가 있다', () => {
    const tool = MEMO_FC_TOOLS.find((t) => t.name === 'memo_create')
    expect(tool).toBeDefined()
    expect(tool!.parameters.required).toContain('text')
  })

  test('memo_search 도구가 있다', () => {
    const tool = MEMO_FC_TOOLS.find((t) => t.name === 'memo_search')
    expect(tool).toBeDefined()
    expect(tool!.parameters.required).toContain('query')
  })
})

describe('getFCTool', () => {
  test('존재하는 도구 반환', () => {
    const tool = getFCTool('memo_create')
    expect(tool?.name).toBe('memo_create')
  })

  test('없는 도구는 undefined', () => {
    expect(getFCTool('nonexistent')).toBeUndefined()
  })
})

describe('validateFCArgs', () => {
  test('유효한 인자', () => {
    const result = validateFCArgs('memo_create', { text: 'hello' })
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('알 수 없는 도구', () => {
    const result = validateFCArgs('unknown_tool', {})
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Unknown tool')
  })

  test('인자가 객체가 아님', () => {
    expect(validateFCArgs('memo_create', null).valid).toBe(false)
    expect(validateFCArgs('memo_create', 'string').valid).toBe(false)
    expect(validateFCArgs('memo_create', undefined).valid).toBe(false)
  })

  test('필수 인자 누락', () => {
    const result = validateFCArgs('memo_create', {})
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Missing required argument')
    expect(result.error).toContain('text')
  })

  test('타입 불일치 (string)', () => {
    const result = validateFCArgs('memo_create', { text: 123 })
    expect(result.valid).toBe(false)
    expect(result.error).toContain('must be a string')
  })

  test('선택적 인자 없어도 유효', () => {
    const result = validateFCArgs('memo_create', { text: 'hello' })
    expect(result.valid).toBe(true)
  })

  test('memo_search 유효', () => {
    const result = validateFCArgs('memo_search', { query: 'test' })
    expect(result.valid).toBe(true)
  })
})

describe('prepareToolsFor (2026-10-26 정정)', () => {
  test('nvidia/groq는 OpenAI 형식으로 래핑', () => {
    const out = prepareToolsFor('nvidia', MEMO_FC_TOOLS)
    expect(out.length).toBe(MEMO_FC_TOOLS.length)
    expect(out[0].type).toBe('function')
    expect(out[0].function.name).toBe('memo_create')
    expect(out[0].function.description).toBeDefined()
    const groq = prepareToolsFor('groq', MEMO_FC_TOOLS)
    expect(groq[0].type).toBe('function')
  })

  // 2026-10-30 정정: 과거 이 테스트는 "workers-ai는 평형식 유지"를 고정하고
  // 있었으나, 그 평형식이 운영 8007(mistral vLLM 검증 오류)의 근본 원인이다.
  // 아래 두 테스트가 그 성질을 지킨다 — prepareToolsFor('workers-ai')를
  // 평형식으로 되돌리면 둘 다 실패해야 한다 (카나리아).
  test('workers-ai도 OpenAI 형식으로 래핑 (8007 회귀 방지)', () => {
    const out = prepareToolsFor('workers-ai', MEMO_FC_TOOLS)
    expect(out.length).toBe(MEMO_FC_TOOLS.length)
    for (let i = 0; i < out.length; i++) {
      expect(out[i].type).toBe('function')
      // function 안에는 원본 도구 정의가 그대로 보존돼야 한다
      expect(out[i].function).toEqual(MEMO_FC_TOOLS[i])
      // 루트에 name/description/parameters가 직접 있으면 vLLM 검증이 거부한다
      expect(out[i].name).toBeUndefined()
      expect(out[i].parameters).toBeUndefined()
    }
    expect(out[0].function.name).toBe('memo_create')
  })

  test('workers-ai 출력은 mistral(vLLM) 도구 스키마 검증을 통과한다', () => {
    // 운영 오류 본문(8007)이 명시한 서버측 계약을 그대로 재현한 검증기:
    // tools[i].function이 필수이고 그 안에 name/description/parameters가 있어야 한다.
    const vllmToolErrors = (tools: any[]): string[] => {
      const errs: string[] = []
      tools.forEach((t, i) => {
        if (!t.function || typeof t.function !== 'object') {
          errs.push(`tools.${i}.function: Field required`)
          return
        }
        for (const field of ['name', 'description', 'parameters'] as const) {
          if (t.function[field] === undefined) errs.push(`tools.${i}.function.${field}: Field required`)
        }
      })
      return errs
    }
    // 전제 확인: 평형식(수정 전 형태)은 실제로 이 검증을 통과하지 못한다
    expect(vllmToolErrors(MEMO_FC_TOOLS as any[]).length).toBe(MEMO_FC_TOOLS.length)
    // 변환 결과는 전 도구 통과해야 한다
    expect(vllmToolErrors(prepareToolsFor('workers-ai', MEMO_FC_TOOLS))).toEqual([])
  })

  test('gemini는 functionDeclarations 변환', () => {
    const out = prepareToolsFor('gemini', MEMO_FC_TOOLS)
    expect(out.length).toBe(1)
    expect(out[0].functionDeclarations[0].name).toBe('memo_create')
    expect(out[0].functionDeclarations.length).toBe(MEMO_FC_TOOLS.length)
  })
})

describe('normalizeFCToolName', () => {
  test('마커형 대문자를 FC 도구명으로 변환', () => {
    expect(normalizeFCToolName('MEMO_CREATE')).toBe('memo_create')
    expect(normalizeFCToolName('MEMO_SEARCH')).toBe('memo_search')
    expect(normalizeFCToolName('MEMO_CREATE_FROM_SOURCE')).toBe('memo_create_from_source')
  })

  test('소문자 도구명은 그대로', () => {
    expect(normalizeFCToolName('memo_get')).toBe('memo_get')
  })

  test('알 수 없는 이름은 그대로 반환 (preflight에서 거부됨)', () => {
    expect(normalizeFCToolName('memo_frobnicate')).toBe('memo_frobnicate')
  })

  test('비문자열·빈 문자열은 null', () => {
    expect(normalizeFCToolName(null)).toBeNull()
    expect(normalizeFCToolName(123)).toBeNull()
    expect(normalizeFCToolName('  ')).toBeNull()
  })
})

describe('normalizeToolCall', () => {
  test('문자열 인자를 JSON 파싱', () => {
    const c = normalizeToolCall({ name: 'memo_create', arguments: '{"text": "hi"}' }, 'call_0')
    expect(c.name).toBe('memo_create')
    expect(c.arguments).toEqual({ text: 'hi' })
    expect(c.parseError).toBeUndefined()
    expect(c.id).toBe('call_0')
  })

  test('function.arguments 형식', () => {
    const c = normalizeToolCall({ function: { name: 'memo_get', arguments: '{"id": 123}' } })
    expect(c.name).toBe('memo_get')
    expect(c.arguments).toEqual({ id: 123 })
  })

  test('tool 필드 + 마커형 이름', () => {
    const c = normalizeToolCall({ tool: 'MEMO_CREATE', arguments: { text: 'x' } })
    expect(c.name).toBe('memo_create')
    expect(c.arguments).toEqual({ text: 'x' })
  })

  test('잘못된 JSON은 침묵하지 않고 parseError 기록', () => {
    const c = normalizeToolCall({ name: 'memo_search', arguments: 'invalid-json{{{' })
    expect(c.parseError).toContain('Invalid JSON arguments')
    expect(c.arguments).toEqual({})
  })

  test('객체 인자는 그대로', () => {
    const c = normalizeToolCall({ name: 'memo_search', arguments: { query: 'q' } })
    expect(c.arguments).toEqual({ query: 'q' })
  })
})

describe('preflightToolCalls', () => {
  test('유효한 호출은 통과', () => {
    const { valid, rejected } = preflightToolCalls([
      { name: 'memo_create', arguments: { text: 'hi' } },
    ])
    expect(valid).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  test('알 수 없는 도구는 거부', () => {
    const { valid, rejected } = preflightToolCalls([
      { name: 'memo_frobnicate', arguments: {} },
    ])
    expect(valid).toHaveLength(0)
    expect(rejected[0].error).toContain('Unknown tool')
  })

  test('필수 인자 누락은 거부', () => {
    const { valid, rejected } = preflightToolCalls([
      { name: 'memo_create', arguments: {} },
    ])
    expect(valid).toHaveLength(0)
    expect(rejected[0].error).toContain('Missing required argument')
  })

  test('parseError가 있는 호출은 거부', () => {
    const { valid, rejected } = preflightToolCalls([
      { name: 'memo_search', arguments: {}, parseError: 'Invalid JSON arguments for memo_search: xxx' },
    ])
    expect(valid).toHaveLength(0)
    expect(rejected[0].error).toContain('Invalid JSON arguments')
  })
})

describe('extractEmbeddedToolCalls', () => {
  test('tool 필드 JSON 추출', () => {
    const calls = extractEmbeddedToolCalls('{"tool":"MEMO_CREATE","arguments":{"text":"메모"}}')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('memo_create')
    expect(calls[0].arguments).toEqual({ text: '메모' })
  })

  test('name 필드 JSON 추출', () => {
    const calls = extractEmbeddedToolCalls('검색할게요 {"name":"memo_search","arguments":{"query":"테스트"}}')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('memo_search')
    expect(calls[0].arguments).toEqual({ query: '테스트' })
  })

  test('코드펜스 안 JSON 추출', () => {
    const calls = extractEmbeddedToolCalls('```json\n{"tool":"MEMO_CREATE","arguments":{"text":"x"}}\n```')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('memo_create')
  })

  test('중첩 JSON(인자 안 객체) 추출', () => {
    const calls = extractEmbeddedToolCalls('{"tool":"MEMO_CREATE","arguments":{"text":"a {b} c"}}')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ text: 'a {b} c' })
  })

  test('도구 JSON이 없으면 빈 배열', () => {
    expect(extractEmbeddedToolCalls('그냥 답변이야.')).toEqual([])
    expect(extractEmbeddedToolCalls('{"foo": 1}')).toEqual([])
    expect(extractEmbeddedToolCalls('')).toEqual([])
  })

  test('arguments 없는 JSON은 무시', () => {
    expect(extractEmbeddedToolCalls('{"tool":"MEMO_CREATE"}')).toEqual([])
  })

  test('최대 3개까지만 추출', () => {
    const text = Array.from({ length: 5 }, (_, i) =>
      `{"tool":"MEMO_SEARCH","arguments":{"query":"q${i}"}}`).join(' ')
    expect(extractEmbeddedToolCalls(text)).toHaveLength(3)
  })
})
