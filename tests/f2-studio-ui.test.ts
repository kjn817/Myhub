/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB, type LoadedPage, type Handler } from './f2-page-harness'

/* ================= F2-4 스튜디오 삭제·게시 ================= */
describe('F2-4 스튜디오 프로젝트 삭제·게시 (agent.html)', () => {
  const project = { id: 7, title: '임시 도우미 앱 하나만', type: 'html', status: 'draft', created_at: '2026-11-07 00:00:00' }
  function makeHandler(state: { deleted: boolean; published: boolean }): Handler {
    return (url: string, init: any) => {
      const p = url.replace('/api/artifact', '')
      if (init?.method === 'DELETE' && p === '/7') { state.deleted = true; return jsonRes({ ok: true }) }
      if (init?.method === 'POST' && p === '/7/publish') { state.published = true; return jsonRes({ ok: true }) }
      if (p === '/') return jsonRes({ ok: true, data: [] })
      if (p === '/drafts') return jsonRes({ ok: true, data: state.deleted ? [] : [project] })
      if (p === '/jobs') return jsonRes({ ok: true, data: [] })
      if (p.startsWith('/chats')) return jsonRes({ ok: true, data: [] })
      if (p === '/7/versions') return jsonRes({ ok: true, data: { versions: [], draft_version_id: null, published_version_id: null } })
      return jsonRes({ ok: true, data: [] })
    }
  }
  function loadStudio(state: { deleted: boolean; published: boolean }) {
    return loadPage('agent.html', makeHandler(state), (w) => {
      // QA 자동화 브라우저와 같은 조건: 네이티브 모달은 자동 해제된다
      w.confirm = () => false
      w.alert = () => {}
      w.CodeMirror = Object.assign(function () {}, {
        fromTextArea: () => ({ getValue: () => '', setValue() {}, on() {}, setOption() {} }),
      })
    })
  }
  async function openMenuAndClick(page: LoadedPage, label: string) {
    const w = page.window
    expect(await until(() => (page.document.getElementById('sbProjects')?.textContent || '').includes(project.title))).toBe(true)
    w.showProjectMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 }, project.id)
    const menu = page.document.getElementById('projectMenu')
    expect(menu).toBeTruthy()
    const btn = [...menu!.querySelectorAll('button')].find((b) => (b.textContent || '').includes(label)) as any
    expect(btn).toBeTruthy()
    btn.click()
  }
  async function clickModalOk(page: LoadedPage, label: string) {
    // 메뉴는 핸들러 시작과 함께 제거되고, 인페이지 모달의 확정 버튼이 남는다
    const found = await until(() => {
      if (page.document.getElementById('projectMenu')) return false
      return [...page.document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === label)
    })
    expect(found).toBe(true)
    const btn = [...page.document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === label).pop() as any
    btn.click()
  }

  it('네이티브 confirm이 자동 해제되는 환경에서도 삭제가 실제로 실행된다', async () => {
    const state = { deleted: false, published: false }
    const page = loadStudio(state)
    await openMenuAndClick(page, '삭제')
    await clickModalOk(page, '삭제')
    expect(await until(() => state.deleted)).toBe(true)
    expect(page.calls.some((c) => c.method === 'DELETE' && c.url === '/api/artifact/7')).toBe(true)
    // 삭제 후 목록에서 사라진다
    expect(await until(() => !(page.document.getElementById('sbProjects')?.textContent || '').includes(project.title))).toBe(true)
  })

  it('게시도 같은 게이트를 통과해 실제로 실행된다', async () => {
    const state = { deleted: false, published: false }
    const page = loadStudio(state)
    await openMenuAndClick(page, '게시하기')
    await clickModalOk(page, '게시하기')
    expect(await until(() => state.published)).toBe(true)
    expect(page.calls.some((c) => c.method === 'POST' && c.url === '/api/artifact/7/publish')).toBe(true)
  })
})
