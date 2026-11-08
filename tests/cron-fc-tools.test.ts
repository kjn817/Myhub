/**
 * 자동화 FC 도구 테스트 — 정의·인자 검증·디스패처 실행
 * FakeD1 사용 — 운영 DB·외부 모델 호출 없음.
 */
import { CRON_FC_TOOLS, getCronFCTool, validateCronFCArgs } from '../src/ai/cron-fc-tools'
import { extractEmbeddedToolCalls } from '../src/ai/memo-fc-tools'
import { dispatchToolCalls as dispatchToolCallsRaw } from '../src/ai/memo-tool-dispatcher'
import { FakeD1, asD1 } from './fake-d1'

// 트랙 3 (D4·D5): 디스패처 공통 게이트가 실행 컨텍스트를 강제하므로,
// 실행 흐름을 검증하는 이 파일의 호출은 keeper·interactive를 명시한다.
const dispatchToolCalls = (env: any, calls: any[], ctx: any = {}) =>
  dispatchToolCallsRaw(env, calls, { personaId: 'keeper', origin: 'interactive' as const, ...ctx })

describe('CRON_FC_TOOLS', () => {
  test('4개 도구 정의 (생성·목록·켜기/끄기·삭제)', () => {
    expect(CRON_FC_TOOLS.map((t) => t.name)).toEqual([
      'cron_create',
      'cron_list',
      'cron_set_enabled',
      'cron_delete',
    ])
    expect(getCronFCTool('cron_create')?.parameters.required).toEqual(['text'])
    expect(getCronFCTool('cron_set_enabled')?.parameters.required).toEqual(['id', 'enabled'])
    expect(getCronFCTool('unknown')).toBeUndefined()
  })

  test('인자 검증 — 필수 누락·타입 오류 거부', () => {
    expect(validateCronFCArgs('cron_create', { text: '매일 8시에 브리핑해줘' }).valid).toBe(true)
    expect(validateCronFCArgs('cron_create', {}).valid).toBe(false)
    expect(validateCronFCArgs('cron_create', { text: 123 }).valid).toBe(false)
    expect(validateCronFCArgs('cron_list', {}).valid).toBe(true)
    expect(validateCronFCArgs('cron_set_enabled', { id: 1, enabled: true }).valid).toBe(true)
    expect(validateCronFCArgs('cron_set_enabled', { id: 1, enabled: 'yes' }).valid).toBe(false)
    expect(validateCronFCArgs('cron_set_enabled', { id: 1 }).valid).toBe(false)
    expect(validateCronFCArgs('cron_delete', { id: '1' }).valid).toBe(false)
    expect(validateCronFCArgs('cron_nope', {}).valid).toBe(false)
  })

  test('임베디드 JSON 폴백이 마커형 CRON 이름을 정규화', () => {
    const calls = extractEmbeddedToolCalls(
      '{"tool": "CRON_CREATE", "arguments": {"text": "매일 아침 8시에 브리핑해줘"}}',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('cron_create')
    expect(calls[0].arguments).toEqual({ text: '매일 아침 8시에 브리핑해줘' })
  })
})

describe('디스패처 cron 도구 실행', () => {
  test('생성 → 목록 → 끄기 → 삭제 전체 흐름', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }

    const [created] = await dispatchToolCalls(env, [
      { name: 'cron_create', arguments: { text: '매일 아침 8시에 뉴스 요약해서 푸시해줘' } },
    ])
    expect(created.success).toBe(true)
    expect(created.data.action).toBe('news-summary')
    expect(created.data.description).toBe('매일 오전 8시에 뉴스 요약을 보내드릴게요.')

    const [listed] = await dispatchToolCalls(env, [{ name: 'cron_list', arguments: {} }])
    expect(listed.success).toBe(true)
    expect(listed.data.jobs).toHaveLength(1)
    const id = listed.data.jobs[0].id as number

    const [disabled] = await dispatchToolCalls(env, [
      { name: 'cron_set_enabled', arguments: { id, enabled: false } },
    ])
    expect(disabled.success).toBe(true)
    expect(disabled.data.enabled).toBe(false)

    const [deleted] = await dispatchToolCalls(env, [
      { name: 'cron_delete', arguments: { id } },
    ])
    expect(deleted.success).toBe(true)
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })

  test('파싱 실패 생성·없는 id 삭제는 실패 결과', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }

    const [badCreate] = await dispatchToolCalls(env, [
      { name: 'cron_create', arguments: { text: '안녕하세요' } },
    ])
    expect(badCreate.success).toBe(false)
    expect(fake.tables.user_cron_jobs).toHaveLength(0)

    const [badDelete] = await dispatchToolCalls(env, [
      { name: 'cron_delete', arguments: { id: 999 } },
    ])
    expect(badDelete.success).toBe(false)
  })

  test('인자 검증 실패 시 실행하지 않고 거부', async () => {
    const fake = new FakeD1()
    const env = { DB: asD1(fake) }
    const [result] = await dispatchToolCalls(env, [
      { name: 'cron_create', arguments: {} },
    ])
    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required argument: text')
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })
})
