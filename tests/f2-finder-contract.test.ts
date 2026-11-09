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

  it('finder.js의 정규화가 filename을 name으로 바꾸고 setView가 /list·/recent·/trash로 분기한다', async () => {
    // finder.js는 IIFE 앱 전체라 통째로 실행할 수 없다 — 대신 운영 원본의 실제
    // 함수들(정규화 헬퍼 + 로더)을 소스에서 추출해 스텁 deps로 실행한다.
    // (재구축 스텁이 발명한 api.tree/normFolder가 아니라 운영의
    //  normalizeFolder/normalizeFile/setView가 검증 대상이다.)
    const src = fs.readFileSync(path.join(PUB, 'js/finder.js'), 'utf8')
    const hStart = src.indexOf('function fmtDate(')
    const hEnd = src.indexOf('function officeAppFor')
    expect(hStart).toBeGreaterThan(-1)
    expect(hEnd).toBeGreaterThan(hStart)
    const helpers = src.slice(hStart, hEnd)
    const lStart = src.indexOf('function loadDrive')
    const lEnd = src.indexOf('function renameFile')
    expect(lStart).toBeGreaterThan(-1)
    expect(lEnd).toBeGreaterThan(lStart)
    const loaders = src.slice(lStart, lEnd)

    const seen: string[] = []
    const folderRef: { current: { id: number | null } } = { current: { id: null } }
    const state: Record<string, unknown> = {
      view: 'drive', listing: null, loadError: false, rootFolders: [],
      favorites: [], sysFoldersEnsured: true, trashData: null, iconTrash: [],
      recentFiles: null, actionMsg: '', armedKey: null,
      appsCatalog: null, appsRequested: false,
    }
    const callJson = async (url: string) => {
      seen.push(url)
      return { folders: [], files: [] }
    }
    const noop = () => undefined
    const factory = new Function(
      'state', 'currentFolder', 'render', 'callJson', 'exitSearchMode',
      'clearSelection', 'syncSidebarActive', 'postToParent', 'setCount',
      'refreshUsage', 'readIconTrash',
      `${helpers}\n${loaders}\nreturn { normalizeFolder, normalizeFile, normalizeTrashFile, setView };`,
    )
    const api = factory(
      state, () => folderRef.current, noop, callJson, noop,
      noop, noop, noop, noop, noop, () => [],
    )

    // 정규화: 서버의 filename이 화면 name이 되고 date는 created_at을 쓴다
    const file = api.normalizeFile({
      id: 9, filename: '문서.pdf', mime: 'application/pdf',
      created_at: '2026-11-02 00:00:00', size: 10,
    })
    expect(file.name).toBe('문서.pdf')
    expect(file.date).toBe('2026-11-02 00:00:00')
    expect(file.kindLabel).toBe('PDF 문서')
    expect(api.normalizeFile({ id: 1 }).name).toBe('이름 없음')
    const folder = api.normalizeFolder({ id: 3, name: '업무', created_at: '2026-11-01 00:00:00' })
    expect(folder.name).toBe('업무')
    expect(folder.date).toBe('2026-11-01 00:00:00')
    expect(folder.kindLabel).toBe('폴더')
    const trashed = api.normalizeTrashFile({
      id: 5, filename: 'a.txt', via_folder: true, deleted_at: '2026-11-03 00:00:00',
    })
    expect(trashed.meta).toBe('폴더와 함께 휴지통에 있음')

    // 뷰 분기: 루트/폴더/최근/휴지통이 각 엔드포인트로 간다
    await api.setView('drive')
    expect(seen[0]).toBe('/api/drive/list')
    folderRef.current = { id: 3 }
    await api.setView('drive')
    expect(seen[1]).toBe('/api/drive/list?folder=3')
    await api.setView('recent')
    expect(seen[2]).toBe('/api/drive/recent')
    await api.setView('trash')
    expect(seen[3]).toBe('/api/drive/trash')
  })
})

