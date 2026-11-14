/// <reference types="jest" />
/**
 * B-L4 마커 파서 공용 헬퍼 + 스케줄 id 해석 (5-7).
 *
 * 고정하는 성질:
 * - parseJsonMarkers: 깨진 JSON은 건너뛰고, map이 null이면 건너뛰고,
 *   상한은 매 매치마다 검사한다. out을 넘기면 여러 정규식이 상한을 공유한다.
 * - 상한 초과 패리티: 원본도 정규식 그룹마다 1개씩 더 들어갈 수 있다
 *   (create 3건 + list 1건 = 4건 — 공용 헬퍼가 원본과 같은 오버슈트).
 * - parseRawMarkers: JSON을 파싱하지 않는다 ([CRON_LIST] 본문 없음).
 * - 리팩터된 파서들: cron 4종·memo 5종·schedule·todo·artifact·google의
 *   매핑·상한·검증이 원본과 동일하다.
 * - resolveScheduleId: id 직행·제목 0건·1건·복수(동사별 문안)·무효 id.
 * 카나리아: 상한 검사를 빼거나 JSON 실패를 throw로 바꾸면 실패한다.
 */
import { parseJsonMarkers, parseRawMarkers } from '../../src/lib/markers'
import {
  parseCronCreateMarkers,
  parseCronListMarkers,
  parseCronDeleteMarkers,
  parseCronToggleMarkers,
} from '../../src/services/cron-tools'
import {
  parseMemoSearchMarkers,
  parseMemoCreateMarkers,
  parseMemoUpdateMarkers,
} from '../../src/services/memo-tools'
import { parseScheduleMarkers, resolveScheduleId } from '../../src/services/schedule-tools'
import { parseTodoMarkers } from '../../src/services/todo-tools'
import { parseArtifactMarkers } from '../../src/services/artifact-tools'
import { parseGoogleMarkers } from '../../src/services/google-tools'

describe('parseJsonMarkers 코어', () => {
  const re = () => /\[X\]([\s\S]*?)\[\/X\]/gi

  test('깨진 JSON은 건너뛰고 다음 매치로 간다', () => {
    const out = parseJsonMarkers(
      '[X]{"a":1}[/X] [X]깨짐[/X] [X]{"a":2}[/X]',
      re(),
      (d, full) => ({ full, a: d.a }),
      10,
    )
    expect(out.map((o) => o.a)).toEqual([1, 2])
  })

  test('map이 null이면 건너뛴다', () => {
    const out = parseJsonMarkers(
      '[X]{"a":0}[/X] [X]{"a":1}[/X]',
      re(),
      (d, full) => (d.a ? { full, a: d.a } : null),
      10,
    )
    expect(out).toHaveLength(1)
  })

  test('상한에 도달하면 멈춘다', () => {
    const out = parseJsonMarkers(
      '[X]{"a":1}[/X] [X]{"a":2}[/X] [X]{"a":3}[/X]',
      re(),
      (d, full) => ({ full, a: d.a }),
      2,
    )
    expect(out.map((o) => o.a)).toEqual([1, 2])
  })

  test('map이 throw해도 건너뛰고 계속한다', () => {
    const out = parseJsonMarkers(
      '[X]{"a":1}[/X] [X]{"a":2}[/X]',
      re(),
      (d, full) => {
        if (d.a === 1) throw new Error('boom')
        return { full, a: d.a }
      },
      10,
    )
    expect(out.map((o) => o.a)).toEqual([2])
  })

  test('out 공유: 두 정규식이 하나의 상한을 나눈다', () => {
    const shared: Array<{ full: string; a: number }> = []
    parseJsonMarkers('[X]{"a":1}[/X] [X]{"a":2}[/X]', re(), (d, f) => ({ full: f, a: d.a }), 2, shared)
    parseJsonMarkers('[X]{"a":3}[/X]', re(), (d, f) => ({ full: f, a: d.a }), 2, shared)
    // 원본과 동일한 오버슈트: 두 번째 호출의 첫 매치는 상한 검사 전에 들어간다
    expect(shared.map((o) => o.a)).toEqual([1, 2, 3])
  })
})

describe('parseRawMarkers 코어', () => {
  test('JSON을 파싱하지 않고 본문을 그대로 넘긴다', () => {
    const out = parseRawMarkers(
      '[L][/L] [L]아무거나[/L]',
      /\[L\]([\s\S]*?)\[\/L\]/gi,
      (full, inner) => ({ full, inner }),
      10,
    )
    expect(out).toEqual([
      { full: '[L][/L]', inner: '' },
      { full: '[L]아무거나[/L]', inner: '아무거나' },
    ])
  })
})

describe('리팩터된 파서 — 매핑·상한', () => {
  test('cron create는 text 필수·500자 절단·상한 2', () => {
    const long = 'x'.repeat(600)
    const out = parseCronCreateMarkers(
      `[CRON_CREATE]{"text":"${long}"}[/CRON_CREATE] [CRON_CREATE]{"text":"b"}[/CRON_CREATE] [CRON_CREATE]{"text":"c"}[/CRON_CREATE] [CRON_CREATE]{"nope":1}[/CRON_CREATE]`,
    )
    expect(out).toHaveLength(2)
    expect(out[0].text).toHaveLength(500)
    expect(out[1].text).toBe('b')
  })

  test('cron list는 본문 없이 full만, 상한 2', () => {
    const out = parseCronListMarkers('[CRON_LIST][/CRON_LIST] [CRON_LIST]무시[/CRON_LIST] [CRON_LIST][/CRON_LIST]')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ full: '[CRON_LIST][/CRON_LIST]' })
  })

  test('cron delete/toggle은 정수 id 필수, toggle enabled 없으면 null', () => {
    expect(parseCronDeleteMarkers('[CRON_DELETE]{"id":3}[/CRON_DELETE] [CRON_DELETE]{"id":1.5}[/CRON_DELETE]')).toEqual([
      { full: '[CRON_DELETE]{"id":3}[/CRON_DELETE]', id: 3 },
    ])
    expect(parseCronToggleMarkers('[CRON_TOGGLE]{"id":3}[/CRON_TOGGLE] [CRON_TOGGLE]{"id":4,"enabled":false}[/CRON_TOGGLE]')).toEqual([
      { full: '[CRON_TOGGLE]{"id":3}[/CRON_TOGGLE]', id: 3, enabled: null },
      { full: '[CRON_TOGGLE]{"id":4,"enabled":false}[/CRON_TOGGLE]', id: 4, enabled: false },
    ])
  })

  test('memo search는 query 200자 절단·상한 3', () => {
    const q = 'y'.repeat(250)
    const out = parseMemoSearchMarkers(`[MEMO_SEARCH]{"query":"${q}"}[/MEMO_SEARCH]`)
    expect(out[0].query).toHaveLength(200)
  })

  test('memo create는 text 우선·title 접두·본문 없으면 건너뜀', () => {
    const out = parseMemoCreateMarkers(
      '[MEMO_CREATE]{"title":"T","text":"본문"}[/MEMO_CREATE] [MEMO_CREATE]{"content":"대체"}[/MEMO_CREATE] [MEMO_CREATE]{"title":"빈"}[/MEMO_CREATE]',
    )
    expect(out).toEqual([
      { full: '[MEMO_CREATE]{"title":"T","text":"본문"}[/MEMO_CREATE]', text: 'T\n\n본문' },
      { full: '[MEMO_CREATE]{"content":"대체"}[/MEMO_CREATE]', text: '대체' },
    ])
  })

  test('memo update는 normalizeMarkerId + text 필수', () => {
    const out = parseMemoUpdateMarkers('[MEMO_UPDATE]{"id":"12","text":"t"}[/MEMO_UPDATE] [MEMO_UPDATE]{"id":"x","text":"t"}[/MEMO_UPDATE]')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(12)
  })

  test('schedule 다중 마커는 상한 3을 공유하고 액션을 구분한다', () => {
    const out = parseScheduleMarkers(
      '[SCHEDULE_CREATE]{"title":"a"}[/SCHEDULE_CREATE] [SCHEDULE_LIST]{}[/SCHEDULE_LIST] [SCHEDULE_UPDATE]{"id":1}[/SCHEDULE_UPDATE] [SCHEDULE_DELETE]{"title":"d"}[/SCHEDULE_DELETE]',
    )
    expect(out.map((o) => o.action)).toEqual(['create', 'list', 'update', 'delete'])
  })

  test('todo 다중 마커는 액션 5종을 구분한다', () => {
    const out = parseTodoMarkers(
      '[TODO_ADD]{"title":"a"}[/TODO_ADD] [TODO_DONE]{"id":1}[/TODO_DONE] [TODO_DELETE]{"title":"d"}[/TODO_DELETE]',
    )
    expect(out.map((o) => o.action)).toEqual(['add', 'done', 'delete'])
  })

  test('artifact 3종 마커는 액션을 구분하고 검증 조건을 유지한다', () => {
    const out = parseArtifactMarkers(
      '[ARTIFACT_CREATE]{"title":"t","html":"<p/>"}[/ARTIFACT_CREATE] [ARTIFACT_CREATE]{"title":"no-content"}[/ARTIFACT_CREATE] [ARTIFACT_FROM_GITHUB]{"repo":"a/b"}[/ARTIFACT_FROM_GITHUB] [ARTIFACT_DELETE]{"id":7}[/ARTIFACT_DELETE]',
    )
    expect(out.map((o) => o.action)).toEqual(['create', 'from_github', 'delete'])
  })

  test('google 마커는 4종 액션을 구분하고 필드를 정제한다', () => {
    const out = parseGoogleMarkers(
      '[GMAIL_SEARCH]{"q":"회의"}[/GMAIL_SEARCH] [GMAIL_GET]{"id":"m1"}[/GMAIL_GET] [GMAIL_GET]{"id":123}[/GMAIL_GET] [GCAL_CREATE]{"title":"점심"}[/GCAL_CREATE]',
    )
    expect(out.map((o) => o.action)).toEqual(['gmail_search', 'gmail_get', 'gcal_create'])
    expect(out[0].data).toEqual({ q: '회의' })
  })
})

describe('resolveScheduleId', () => {
  function makeEnv(rows: any[]) {
    return {
      DB: {
        prepare() {
          return {
            bind() {
              return { all: async () => ({ results: rows }) }
            },
          }
        },
      },
    }
  }

  test('유효한 id면 DB 조회 없이 직행한다', async () => {
    let queried = false
    const env = {
      DB: {
        prepare() {
          queried = true
          throw new Error('should not query')
        },
      },
    }
    await expect(resolveScheduleId(env, { id: 5 }, '수정')).resolves.toEqual({ ok: true, id: 5 })
    expect(queried).toBe(false)
  })

  test('문자열 id도 숫자로 해석한다', async () => {
    await expect(resolveScheduleId(makeEnv([]), { id: '42' }, '삭제')).resolves.toEqual({ ok: true, id: 42 })
  })

  test('제목 0건이면 찾을 수 없음', async () => {
    const r = await resolveScheduleId(makeEnv([]), { title: '없는 일정' }, '수정')
    expect(r).toEqual({ ok: false, result: { success: false, error: '"없는 일정" 일정을 찾을 수 없음' } })
  })

  test('제목 1건이면 그 id로 확정한다', async () => {
    const r = await resolveScheduleId(
      makeEnv([{ id: 9, title: '회의', start_at: '2026-11-14T10:00' }]),
      { title: '회의' },
      '수정',
    )
    expect(r).toEqual({ ok: true, id: 9 })
  })

  test('제목 복수면 후보 목록 + 동사별 문안', async () => {
    const rows = [
      { id: 1, title: '회의', start_at: '2026-11-14T10:00' },
      { id: 2, title: '회의2', start_at: '2026-11-15T10:00' },
    ]
    const update = await resolveScheduleId(makeEnv(rows), { title: '회의' }, '수정')
    const del = await resolveScheduleId(makeEnv(rows), { title: '회의' }, '삭제')
    expect(update).toMatchObject({
      ok: false,
      result: { success: false, error: 'multiple_candidates', message: '여러 일정이 발견됨. 수정할 일정을 선택해주세요.' },
    })
    expect((update as any).result.candidates).toHaveLength(2)
    expect((del as any).result.message).toBe('여러 일정이 발견됨. 삭제할 일정을 선택해주세요.')
  })

  test('id도 제목도 없으면 유효성 오류', async () => {
    const r = await resolveScheduleId(makeEnv([]), {}, '수정')
    expect(r).toEqual({ ok: false, result: { success: false, error: '유효한 일정 ID나 제목이 필요' } })
  })
})
