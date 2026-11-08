/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB, type LoadedPage, type Handler } from './f2-page-harness'

/* ================= F2-3 일정 앱 ================= */
describe('F2-3 일정 앱 (schedule.html + js/schedule.js)', () => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const event = {
    id: 5, title: 'F2 렌더 확인 일정', start_at: `${today}T10:00`, end_at: `${today}T11:00`,
    location: '', description: '', status: 'active', recurrence_rule: null,
  }
  function handler(url: string) {
    if (url.startsWith('/api/schedule/list')) return jsonRes({ ok: true, schedules: [event] })
    if (url.startsWith('/api/schedule/create')) return jsonRes({ ok: true, id: 99, google: { state: 'off' } })
    if (url.startsWith('/api/push/vapid-key')) return jsonRes({ ok: false })
    if (url.startsWith('/api/google/status')) return jsonRes({ connected: false })
    return jsonRes({ ok: true })
  }

  it('월 그리드가 렌더링되고, 새 일정 저장이 POST /create로 나간다', async () => {
    const page = loadPage('schedule.html', handler)
    const title = page.document.getElementById('calTitle') as any
    expect(await until(() => /\d{4}년 \d{1,2}월/.test(title.textContent || ''))).toBe(true)
    const grid = page.document.getElementById('calGrid') as any
    expect(grid.children.length).toBeGreaterThanOrEqual(49)
    const dayItems = page.document.getElementById('dayItems') as any
    expect(await until(() => (dayItems.textContent || '').includes('F2 렌더 확인 일정'))).toBe(true)

    ;(page.document.getElementById('addBtn') as any).click()
    ;(page.document.getElementById('fTitle') as any).value = 'F2 저장 일정'
    ;(page.document.getElementById('fStart') as any).value = `${today}T22:00`
    ;(page.document.getElementById('saveBtn') as any).click()
    expect(await until(() => page.calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/schedule/create')))).toBe(true)
    const create = page.calls.find((c) => c.method === 'POST' && c.url.startsWith('/api/schedule/create')) as any
    expect(JSON.parse(create.body).title).toBe('F2 저장 일정')
  })
})

