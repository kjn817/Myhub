/**
 * studio-tools.ts 100% 커버리지 테스트
 *
 * 이 파일은 선언형 데이터만 포함한다:
 * - StudioToolCall / StudioToolResult: 타입 전용 인터페이스 (런타임 코드 없음)
 * - STUDIO_TOOLS: OpenAI Function Calling 형식의 도구 정의 9개
 * - STUDIO_AGENT_SYSTEM: 에이전트용 시스템 프롬프트 문자열
 *
 * 분기/함수 로직이 없으므로 import 자체로 모든 문장이 실행되지만,
 * 아래 테스트는 각 도구 정의의 구조·필수 파라미터·설명 문구를 전부 검증한다.
 * (구조가 깨지면 에이전트의 Function Calling 스키마가 깨지므로 중요)
 */
/// <reference types="jest" />
import { STUDIO_TOOLS, STUDIO_AGENT_SYSTEM } from '../../src/services/studio-tools'
import type { StudioToolCall, StudioToolResult } from '../../src/services/studio-tools'

describe('STUDIO_TOOLS 구조', () => {
  test('도구 9개가 정의되어 있다', () => {
    expect(STUDIO_TOOLS).toHaveLength(9)
  })

  test('도구 이름이 중복되지 않는다', () => {
    const names = STUDIO_TOOLS.map(t => t.function.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('모든 도구가 OpenAI Function Calling 형식을 따른다', () => {
    for (const tool of STUDIO_TOOLS) {
      expect(tool.type).toBe('function')
      expect(typeof tool.function.name).toBe('string')
      expect(tool.function.name.length).toBeGreaterThan(0)
      expect(typeof tool.function.description).toBe('string')
      expect(tool.function.description.length).toBeGreaterThan(0)
      expect(tool.function.parameters.type).toBe('object')
      expect(typeof tool.function.parameters.properties).toBe('object')
      // required는 선택 사항 (list_files처럼 파라미터 없는 도구도 있음)
      const required = tool.function.parameters.required
      if (required !== undefined) {
        expect(Array.isArray(required)).toBe(true)
        // required에 나열된 파라미터는 properties에 반드시 존재
        for (const req of required) {
          expect(tool.function.parameters.properties).toHaveProperty(req)
        }
      }
    }
  })

  test('예상된 도구 이름 집합과 일치한다', () => {
    const names = STUDIO_TOOLS.map(t => t.function.name).sort()
    expect(names).toEqual([
      'apply_patch',
      'ask_question',
      'create_file',
      'delete_file',
      'edit_file',
      'list_files',
      'read_file',
      'search_in_files',
      'validate_files',
    ])
  })
})

describe('개별 도구 정의', () => {
  const byName = (name: string) =>
    STUDIO_TOOLS.find(t => t.function.name === name)!.function

  test('create_file', () => {
    const f = byName('create_file')
    expect(f.parameters.properties).toHaveProperty('path')
    expect(f.parameters.properties).toHaveProperty('content')
    expect(f.parameters.required).toEqual(['path', 'content'])
    expect(f.parameters.properties.path.type).toBe('string')
    expect(f.parameters.properties.content.type).toBe('string')
  })

  test('edit_file', () => {
    const f = byName('edit_file')
    expect(f.parameters.required).toEqual(['path', 'old_string', 'new_string'])
    expect(f.parameters.properties.path.type).toBe('string')
    expect(f.parameters.properties.old_string.type).toBe('string')
    expect(f.parameters.properties.new_string.type).toBe('string')
  })

  test('read_file', () => {
    const f = byName('read_file')
    expect(f.parameters.required).toEqual(['path'])
    expect(f.parameters.properties.path.type).toBe('string')
  })

  test('list_files: 파라미터 없음', () => {
    const f = byName('list_files')
    // required가 없거나 빈 배열이어야 함
    expect(f.parameters.required ?? []).toEqual([])
    expect(Object.keys(f.parameters.properties)).toHaveLength(0)
  })

  test('search_in_files', () => {
    const f = byName('search_in_files')
    expect(f.parameters.required).toEqual(['pattern'])
    expect(f.parameters.properties.pattern.type).toBe('string')
    // file_pattern은 선택 사항
    expect(f.parameters.properties.file_pattern.type).toBe('string')
    expect(f.parameters.required).not.toContain('file_pattern')
  })

  test('validate_files: files 선택 사항', () => {
    const f = byName('validate_files')
    expect(f.parameters.required).toEqual([])
    expect(f.parameters.properties.files.type).toBe('string')
  })

  test('delete_file', () => {
    const f = byName('delete_file')
    expect(f.parameters.required).toEqual(['path'])
  })

  test('apply_patch', () => {
    const f = byName('apply_patch')
    expect(f.parameters.required).toEqual(['patch'])
    expect(f.parameters.properties.patch.type).toBe('string')
    // 설명에 Codex 패치 형식이 안내되어 있다
    expect(f.description).toContain('*** Begin Patch')
    expect(f.description).toContain('*** Update File:')
  })
})

describe('STUDIO_AGENT_SYSTEM', () => {
  test('비어 있지 않다', () => {
    expect(typeof STUDIO_AGENT_SYSTEM).toBe('string')
    expect(STUDIO_AGENT_SYSTEM.length).toBeGreaterThan(0)
  })

  test('노바 정체성을 포함한다', () => {
    expect(STUDIO_AGENT_SYSTEM).toContain('노바')
  })

  test('도구 사용 안내를 포함한다', () => {
    expect(STUDIO_AGENT_SYSTEM).toContain('create_file')
    expect(STUDIO_AGENT_SYSTEM).toContain('edit_file')
    expect(STUDIO_AGENT_SYSTEM).toContain('스스로 판단')
  })

  test('HTML 완전 문서 규칙을 포함한다', () => {
    expect(STUDIO_AGENT_SYSTEM).toContain('<!DOCTYPE html>')
  })

  test('색상 변경 예시를 포함한다', () => {
    expect(STUDIO_AGENT_SYSTEM).toContain('파란색')
    expect(STUDIO_AGENT_SYSTEM).toContain('search_in_files')
  })

  test('과도한 제약 문구가 없다 (사용자 요구: 노바를 제약하지 말 것)', () => {
    // 구버전 프롬프트의 하드코딩 규칙이 부활하지 않았는지 확인
    expect(STUDIO_AGENT_SYSTEM).not.toContain('반드시 도구를 호출')
    expect(STUDIO_AGENT_SYSTEM).not.toContain('1-2-3-4 순서대로')
  })
})

describe('타입 인터페이스 (컴파일 타임 검증)', () => {
  test('StudioToolCall 형태', () => {
    const call: StudioToolCall = {
      name: 'create_file',
      arguments: { path: 'a.html', content: '<html>' },
    }
    expect(call.name).toBe('create_file')
    // id는 선택 사항
    const withId: StudioToolCall = { name: 'read_file', arguments: {}, id: 'call-1' }
    expect(withId.id).toBe('call-1')
  })

  test('StudioToolResult 형태', () => {
    const ok: StudioToolResult = { ok: true, output: 'done' }
    expect(ok.ok).toBe(true)
    // error는 선택 사항
    const err: StudioToolResult = { ok: false, output: '', error: '실패' }
    expect(err.error).toBe('실패')
  })
})
