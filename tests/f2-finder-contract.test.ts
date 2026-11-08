/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB, type LoadedPage, type Handler } from './f2-page-harness'

/* ================= F2-1 Finder 계약 (프론트 측) ================= */
describe('F2-1 Finder 프론트 계약', () => {
  it('finder·picker·fonts·desktop이 존재하지 않는 /api/drive/tree를 부르지 않는다', () => {
    for (const f of ['js/finder.js', 'js/office-picker.js', 'js/fonts.js', 'js/desktop/main.js']) {
      const src = fs.readFileSync(path.join(PUB, f), 'utf8')
      expect(src).not.toContain('/api/drive/tree')
    }
  })

  it('finder.js의 tree()가 /list·/recent·/trash로 분기하고 filename을 name으로 정규화한다', async () => {
    // finder.js는 IIFE 앱 전체라 api 객체만 격리 평가할 수 없다 — 대신
    // 소스에서 정규화 함수+api.tree 정의를 추출해 fetch 스텁으로 실행한다.
    const src = fs.readFileSync(path.join(PUB, 'js/finder.js'), 'utf8')
    const start = src.indexOf('function normFolder')
    const end = src.indexOf('usage: function')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const chunk = src.slice(start, end)
    const seen: string[] = []
    const fakeFetch = async (url: string) => {
      seen.push(url)
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, folder: null,
          folders: [{ id: 3, name: '업무', created_at: '2026-11-01 00:00:00' }],
          files: [{ id: 9, filename: '문서.pdf', created_at: '2026-11-02 00:00:00', via_folder: false }],
        }),
      }
    }
    // chunk는 "var api = { tree: ...," 까지라 객체 리터럴을 닫아 완성한다
    const factory = new Function('fetch', `${chunk}}; return api;`)
    const api = factory(fakeFetch)
    const root = await api.tree('root')
    expect(seen[0]).toBe('/api/drive/list?folder=root')
    expect(root.files[0].name).toBe('문서.pdf')
    expect(root.files[0].updated_at).toBe('2026-11-02 00:00:00')
    expect(root.folders[0].updated_at).toBe('2026-11-01 00:00:00')
    await api.tree('recent')
    expect(seen[1]).toBe('/api/drive/recent')
    await api.tree('trash')
    expect(seen[2]).toBe('/api/drive/trash')
    await api.tree(3)
    expect(seen[3]).toBe('/api/drive/list?folder=3')
  })
})

