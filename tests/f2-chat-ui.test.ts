/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB, type LoadedPage, type Handler } from './f2-page-harness'

/* ================= F2-2 채팅 앱 ================= */
describe('F2-2 채팅 앱 (chat.html + chat.js)', () => {
  const personas = [
    { id: 'concierge', name: '루미', avatar: '/avatars/rumi-128.webp', desc: '대표 비서' },
    { id: 'keeper', name: '에코', avatar: '/avatars/echo-128.webp', desc: '기록 담당' },
    { id: 'builder', name: '노바', avatar: '/avatars/nova-128.webp', desc: '만들기 담당' },
    { id: 'scheduler', name: '캘리', avatar: '/avatars/cali-128.webp', desc: '일정·할일 담당' },
  ]
  // 서버 실제 동작: /api/ai/chat이 대화를 저장하고, 이후 room-history가
  // 저장된 메시지를 돌려줘 화면이 다시 그려진다 — 스텁도 같은 상태 전이를 따른다.
  let savedMessages: any[] = []
  function handler(url: string, init: any) {
    if (url.startsWith('/api/ai/personas')) return jsonRes(personas)
    if (url.startsWith('/api/ai/conversations')) return jsonRes({ ok: true, conversations: [], hasMore: false, nextOffset: null })
    if (url.startsWith('/api/ai/room-history')) return jsonRes({ ok: true, messages: savedMessages, hasMore: false })
    if (url.startsWith('/api/ai/chat') && init?.method === 'POST') {
      savedMessages = [
        { id: 1, persona_id: 'concierge', role: 'user', content: '안녕하세요', created_at: '2026-11-07 00:00:00' },
        { id: 2, persona_id: 'concierge', role: 'assistant', content: '네, 응답입니다.', created_at: '2026-11-07 00:00:01' },
      ]
    }
    if (url.startsWith('/api/ai/models')) return jsonRes({ ok: true, models: [] })
    if (url.startsWith('/api/ai/settings')) return jsonRes({ ok: true, settings: {} })
    if (url.startsWith('/api/ai/quota')) return jsonRes({ ok: true, usage: [], budgets: {} })
    if (url.startsWith('/api/ai/chat')) return jsonRes({ ok: true, text: '네, 응답입니다.', conversationId: 42, model: 'gemini/test-model', messageId: 7 })
    return jsonRes({ ok: true })
  }

  it('로컬 벤더만으로 부팅되고, 전송하면 /api/ai/chat 응답이 렌더링된다', async () => {
    const page = loadPage('chat.html', handler)
    // chat.js가 죽으면 loadPersonas조차 안 돈다 — 부팅 fetch가 증거
    expect(await until(() => page.calls.some((c) => c.url.startsWith('/api/ai/personas')))).toBe(true)
    expect(page.errors.filter((e) => e.script.includes('chat.js'))).toEqual([])

    const input = page.document.getElementById('input') as any
    input.value = '안녕하세요'
    ;(page.document.getElementById('send') as any).click()
    expect(await until(() => page.calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/ai/chat')))).toBe(true)
    const msgs = page.document.getElementById('msgs') as any
    expect(await until(() => (msgs.textContent || '').includes('네, 응답입니다.'))).toBe(true)
    expect(msgs.textContent).toContain('안녕하세요')
  })
})

