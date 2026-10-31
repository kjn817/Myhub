/// <reference types="jest" />

import { TEST_TOOLS, testFunctionCalling } from '../../src/ai/fc-test'

describe('TEST_TOOLS', () => {
  test('test_echo 도구가 정의되어 있다', () => {
    expect(TEST_TOOLS).toHaveLength(1)
    expect(TEST_TOOLS[0].name).toBe('test_echo')
    expect(TEST_TOOLS[0].description).toContain('Echo')
    expect(TEST_TOOLS[0].parameters.required).toContain('text')
  })
})

describe('testFunctionCalling', () => {
  test('AI 바인딩이 없으면 실패 반환', async () => {
    const result = await testFunctionCalling({})
    expect(result.success).toBe(false)
    expect(result.hasToolCalls).toBe(false)
    expect(result.error).toBe('AI binding missing')
  })

  test('AI 바인딩이 null이면 실패 반환', async () => {
    const result = await testFunctionCalling({ AI: null })
    expect(result.success).toBe(false)
    expect(result.error).toBe('AI binding missing')
  })

  test('성공 시 tool_calls 반환', async () => {
    const mockAI = {
      run: jest.fn().mockResolvedValue({
        tool_calls: [{ name: 'test_echo', arguments: { text: 'hello world' } }],
      }),
    }
    const result = await testFunctionCalling({ AI: mockAI })
    expect(result.success).toBe(true)
    expect(result.hasToolCalls).toBe(true)
    expect(result.toolCalls).toHaveLength(1)
    expect(mockAI.run).toHaveBeenCalledWith(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      expect.objectContaining({ tools: TEST_TOOLS }),
      // AI Gateway 관측성 (트랙 B2): gateway 옵션이 3번째 인자로 전달된다
      { gateway: { id: 'default' } }
    )
  })

  test('toolCalls (camelCase) 형식도 인식', async () => {
    const mockAI = {
      run: jest.fn().mockResolvedValue({
        toolCalls: [{ name: 'test_echo' }],
      }),
    }
    const result = await testFunctionCalling({ AI: mockAI })
    expect(result.hasToolCalls).toBe(true)
  })

  test('tool_calls가 없으면 hasToolCalls false', async () => {
    const mockAI = {
      run: jest.fn().mockResolvedValue({ response: 'hello' }),
    }
    const result = await testFunctionCalling({ AI: mockAI })
    expect(result.success).toBe(true)
    expect(result.hasToolCalls).toBe(false)
    expect(result.toolCalls).toEqual([])
  })

  test('AI 호출 실패 시 error 반환', async () => {
    const mockAI = {
      run: jest.fn().mockRejectedValue(new Error('model failed')),
    }
    const result = await testFunctionCalling({ AI: mockAI })
    expect(result.success).toBe(false)
    expect(result.hasToolCalls).toBe(false)
    expect(result.error).toBe('model failed')
  })

  test('문자열이 아닌 에러도 처리', async () => {
    const mockAI = {
      run: jest.fn().mockRejectedValue('string error'),
    }
    const result = await testFunctionCalling({ AI: mockAI })
    expect(result.success).toBe(false)
    expect(result.error).toBe('string error')
  })
})
