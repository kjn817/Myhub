/// <reference types="jest" />
/**
 * B-L9 jscpd 클론 통합 (5-7).
 *
 * 고정하는 성질:
 * - html-meta: getAttr(따옴표·대소문자 무시), metaContent(첫 일치 태그·
 *   대소문자 무시 값 매칭), transform 인자(없으면 원본, 있으면 변환값).
 * - news-enrich의 metaDescription 동등성: og:description은 엔티티 디코드 + trim,
 *   article-date의 extractArticlePublishedDate는 원본 그대로.
 * - google-client mapApiResult: 성공 매핑·실패 그대로 반환. listCalendarEvents
 *   실패 시 apiMessage가 보존된다 (구 재구성은 떨어뜨렸음 — 호출처는 error만
 *   읽어 관측 동작 동일).
 * - office-ops validate 프롤로그: sheet만 개수 초과 오류를 루프 전에 남기고,
 *   hwp/pdf는 조용히 절단한다. 형식 불량 항목은 3종 모두 건너뛴다.
 * - sandbox 미리보기: 대상 없음 문안·제목 라벨이 5개 케이스에서 동일하다.
 * 카나리아: transform을 빼거나 sheet의 warnTooMany를 빼면 실패한다.
 */
import { getAttr, metaContent } from '../../src/lib/html-meta'
import { extractArticlePublishedDate } from '../../src/services/article-date'
import { extractArticleBodyText } from '../../src/services/news-enrich'
import { listCalendarEvents, createCalendarEvent } from '../../src/services/google-client'
import { validateSheetOps, validateHwpOps, validatePdfOps } from '../../src/services/office-ops'
import { buildDryRunPreview } from '../../src/services/sandbox'
import { FakeD1, asD1 } from '../fake-d1'

describe('html-meta', () => {
  test('getAttr는 따옴표·대소문자를 무시하고 값을 뽑는다', () => {
    expect(getAttr(`<meta property="x" content='v1'>`, 'content')).toBe('v1')
    expect(getAttr('<meta CONTENT="v2">', 'content')).toBe('v2')
    expect(getAttr('<meta property="x">', 'content')).toBeUndefined()
  })

  test('metaContent는 첫 일치 태그의 content를 낸다', () => {
    const html = '<meta property="og:title" content="첫째"><meta property="og:title" content="둘째">'
    expect(metaContent(html, 'property', 'og:title')).toBe('첫째')
    expect(metaContent(html, 'property', 'OG:TITLE')).toBe('첫째')
    expect(metaContent(html, 'name', 'og:title')).toBeUndefined()
  })

  test('transform이 없으면 원본, 있으면 변환값을 낸다', () => {
    const html = '<meta name="description" content="  A &amp; B  ">'
    expect(metaContent(html, 'name', 'description')).toBe('  A &amp; B  ')
    expect(metaContent(html, 'name', 'description', (c) => c.replace(/&amp;/g, '&').trim())).toBe('A & B')
  })

  test('article-date는 메타 날짜를 원본 그대로 쓴다', () => {
    const html = '<html><head><meta property="article:published_time" content="2026-11-14T10:00:00+09:00"></head></html>'
    expect(extractArticlePublishedDate(html, new Date('2026-11-14T00:00:00Z'))).toBe('2026-11-14T01:00:00.000Z')
  })

  test('news-enrich og:description은 엔티티 디코드 + trim 후 본문 후보로 쓴다', () => {
    const long = `요약 &amp; 설명 `.repeat(10)
    const html = `<html><head><meta property="og:description" content="${long}"></head><body><p>짧다</p></body></html>`
    const body = extractArticleBodyText(html)
    expect(body).toContain('요약 & 설명')
    expect(body).not.toContain('&amp;')
  })
})

describe('google-client mapApiResult', () => {
  function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; json: any }): typeof fetch {
    return (async (url: any, init?: any) =>
      new Response(JSON.stringify(handler(String(url), init).json), {
        status: handler(String(url), init).status,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
  }

  test('createCalendarEvent 성공 시 toCalendarEvent로 매핑한다', async () => {
    const fetchFn = mockFetch(() => ({
      status: 200,
      json: { id: 'e1', summary: '회의', start: { dateTime: '2026-11-14T10:00:00+09:00' }, end: { dateTime: '2026-11-14T11:00:00+09:00' } },
    }))
    const res = await createCalendarEvent(fetchFn, 'tok', { summary: '회의', start: '2026-11-14T10:00:00+09:00', end: '2026-11-14T11:00:00+09:00' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.summary).toBe('회의')
  })

  test('listCalendarEvents 실패 시 error와 apiMessage를 보존한다', async () => {
    const fetchFn = mockFetch(() => ({
      status: 403,
      json: { error: { message: 'Calendar API has not been used' } },
    }))
    const res = await listCalendarEvents(fetchFn, 'tok', { timeMin: '2026-11-14T00:00:00+09:00', timeMax: '2026-11-14T23:59:59+09:00' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('google_api_error:403')
      expect(res.apiMessage).toBe('Calendar API has not been used')
    }
  })
})

describe('office-ops validate 프롤로그', () => {
  test('sheet만 개수 초과 오류를 남기고, 오류는 루프 전(첫째)이다', () => {
    const many = Array.from({ length: 60 }, () => ({ type: 'set_cell', cell: 'A1', value: 1 }))
    const sheet = validateSheetOps(many)
    expect(sheet.errors[0]).toMatch(/연산이 너무 많습니다/)
    expect(sheet.ops).toHaveLength(24) // MAX_OPS
  })

  test('hwp·pdf는 개수 초과를 조용히 절단한다', () => {
    const manyHwp = Array.from({ length: 60 }, () => ({ type: 'append_paragraphs', paragraphs: ['x'] }))
    expect(validateHwpOps(manyHwp).errors).toEqual([])
    const manyPdf = Array.from({ length: 60 }, () => ({ type: 'rotate_page', page: 1 }))
    expect(validatePdfOps(manyPdf, 3).errors).toEqual([])
  })

  test('형식 불량 항목은 3종 모두 건너뛰고 오류를 남긴다', () => {
    const bad = [null, 'str', { nope: true }, { type: 'set_cell', cell: 'A1', value: 1 }]
    const sheet = validateSheetOps(bad)
    expect(sheet.ops).toHaveLength(1)
    expect(sheet.errors.filter((e) => e === '형식이 잘못된 연산을 건너뜀')).toHaveLength(3)
    const hwp = validateHwpOps([null, { type: 'append_paragraphs', paragraphs: ['x'] }])
    expect(hwp.ops).toHaveLength(1)
    expect(hwp.errors).toEqual(['형식이 잘못된 연산을 건너뜀'])
  })

  test('배열이 아니면 3종 모두 같은 오류', () => {
    expect(validateSheetOps(null).errors).toEqual(['연산 목록이 배열이 아닙니다'])
    expect(validateHwpOps('x').errors).toEqual(['연산 목록이 배열이 아닙니다'])
    expect(validatePdfOps(undefined, 1).errors).toEqual(['연산 목록이 배열이 아닙니다'])
  })
})

describe('sandbox 미리보기 — 대상 없음·제목 라벨', () => {
  function makeFake() {
    const fake = new FakeD1()
    fake.tables.schedules.push({
      id: 7, title: '주간 회의', description: '', location: '',
      start_at: '2027-01-01T10:00', end_at: '2027-01-01T11:00',
      timezone: 'Asia/Seoul', recurrence_rule: null, status: 'active',
      created_at: '', updated_at: '',
    })
    fake.tables.todos.push({ id: 7, title: '보고서 쓰기', description: '', due_at: null, priority: 1, status: 'pending' })
    return fake
  }

  test('대상 없음 문안이 일정·할 일에서 동일하다', async () => {
    const db = asD1(makeFake())
    const s = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 999 }, 'k')
    const t = await buildDryRunPreview(db, 'TODO_DELETE', { id: 999 }, 'k')
    expect(s.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
    expect(t.warnings).toEqual(s.warnings)
    expect(s.targetLabel).toBe('일정 #999')
    expect(t.targetLabel).toBe('할 일 #999')
    expect(s.targetFound).toBe(false)
  })

  test('제목 라벨 형식이 일정·할 일에서 동일하다', async () => {
    const db = asD1(makeFake())
    const s = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 7 }, 'k')
    const t = await buildDryRunPreview(db, 'TODO_DELETE', { id: 7 }, 'k')
    expect(s.targetLabel).toBe('일정 #7 "주간 회의"')
    expect(t.targetLabel).toBe('할 일 #7 "보고서 쓰기"')
    expect(s.targetFound).toBe(true)
  })
})
