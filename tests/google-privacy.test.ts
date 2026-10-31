/**
 * Google 개인정보 경계 테스트 — AI 전송 전 정제
 * 마스킹·본문 절단·참석자 이메일 제외·건수 제한을 검증한다.
 */
import {
  sanitizeGmailMessageForAI,
  sanitizeCalendarEventForAI,
  sanitizeGmailListForAI,
  sanitizeCalendarListForAI,
  AI_MAIL_BODY_MAX_CHARS,
  AI_EVENT_DESC_MAX_CHARS,
  AI_MAX_ITEMS,
} from '../src/services/google-privacy'

const CARD = '4111-1111-1111-1111' // Luhn 통과 테스트 카드번호

describe('Gmail 정제', () => {
  test('카드번호·API 키 마스킹, maskedCount 집계', () => {
    const out = sanitizeGmailMessageForAI({
      id: 'm1',
      threadId: 't',
      from: 'sender@example.com',
      subject: `키 안내 sk-abcdefghij1234567890`,
      date: 'Mon, 26 Oct 2026',
      snippet: '스니펫',
      bodyText: `카드 ${CARD} 와 password=secret123`,
    })
    expect(out.body).not.toContain(CARD)
    expect(out.body).toContain('[CARD_MASKED]')
    expect(out.body).not.toContain('secret123')
    expect(out.subject).toContain('[API_KEY_MASKED]')
    expect(out.maskedCount).toBeGreaterThan(0)
  })

  test('본문 2,000자 절단', () => {
    const out = sanitizeGmailMessageForAI({
      id: 'm1',
      threadId: 't',
      from: 'a@b.com',
      subject: 's',
      date: '',
      snippet: '',
      bodyText: 'x'.repeat(AI_MAIL_BODY_MAX_CHARS + 500),
    })
    expect(out.body.length).toBe(AI_MAIL_BODY_MAX_CHARS)
  })

  test('목록 정제 — 최대 10건', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`,
      threadId: 't',
      from: 'a@b.com',
      subject: `제목${i}`,
      date: '',
      snippet: '',
    }))
    expect(sanitizeGmailListForAI(msgs)).toHaveLength(AI_MAX_ITEMS)
  })
})

describe('캘린더 정제', () => {
  test('참석자 이메일은 제외, 수만 전달', () => {
    const out = sanitizeCalendarEventForAI({
      id: 'e1',
      summary: '회의',
      description: '설명',
      start: '2026-10-27T14:00:00+09:00',
      end: '2026-10-27T15:00:00+09:00',
      location: '서울',
      attendeeCount: 3,
      status: 'confirmed',
    })
    expect(out.attendeeCount).toBe(3)
    expect(JSON.stringify(out)).not.toContain('@')
  })

  test('설명 500자 절단 + 마스킹', () => {
    const out = sanitizeCalendarEventForAI({
      id: 'e1',
      summary: '회의',
      description: `카드 ${CARD} ` + 'y'.repeat(AI_EVENT_DESC_MAX_CHARS + 100),
      start: '',
      end: '',
      location: '',
      attendeeCount: 0,
      status: '',
    })
    expect(out.description.length).toBeLessThanOrEqual(AI_EVENT_DESC_MAX_CHARS)
    expect(out.description).not.toContain(CARD)
  })

  test('목록 정제 — 최대 10건', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      summary: `일정${i}`,
      description: '',
      start: '',
      end: '',
      location: '',
      attendeeCount: 0,
      status: '',
    }))
    expect(sanitizeCalendarListForAI(events)).toHaveLength(AI_MAX_ITEMS)
  })
})
