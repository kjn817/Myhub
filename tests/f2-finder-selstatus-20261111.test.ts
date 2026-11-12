/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * Finder 하단 좌측 선택 표시 전이 (2026-11-11 앱 대조 카탈로그).
 * 선택 없음: '보관함 선택' → 행 선택: 'N개 선택'.
 * 클릭이 필요한 검증이라 다른 페이지 로드와 격리된 파일에 둔다.
 */
import { loadPage, until, jsonRes, type Handler } from './f2-page-harness'

describe('Finder 하단 선택 표시 전이', () => {
  const LIST = {
    folder: null,
    folders: [{ id: 11, name: '다운로드', created_at: '2026-11-04T06:29:00' }],
    files: [
      { id: 21, filename: '메모.txt', size: 128, created_at: '2026-11-08T10:00:00', mime: 'text/plain' },
      { id: 22, filename: '사진.png', size: 256, created_at: '2026-11-08T10:00:00', mime: 'image/png' },
    ],
  }
  const handler: Handler = (url: string) => {
    if (url.includes('/api/drive/list')) return jsonRes(LIST)
    if (url.includes('/api/drive/usage')) return jsonRes({ files: 3, bytes: 1024 })
    if (url.includes('/api/drive/recent')) return jsonRes({ folders: [], files: [] })
    if (url.includes('/api/drive/trash')) return jsonRes({ folders: [], files: [] })
    return jsonRes({})
  }

  it("초기 '보관함 선택'에서 행을 클릭하면 '1개 선택'으로 바뀐다", async () => {
    const page = loadPage('finder.html', handler)
    expect(await until(() => page.document.querySelectorAll('.finder-row').length >= 3)).toBe(true)
    expect(page.document.getElementById('finderSelStatus')!.textContent).toBe('보관함 선택')
    const row = page.document.querySelector('.finder-row') as any
    row.click()
    expect(await until(() => page.document.getElementById('finderSelStatus')!.textContent === '1개 선택')).toBe(true)
    // 오른쪽 상태는 종전대로 전체 항목 수를 유지한다
    expect(page.document.getElementById('finderStatus')!.textContent).toContain('3개 중 1개 선택')
  })
})
