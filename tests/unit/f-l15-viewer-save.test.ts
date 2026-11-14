/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F-L15 뷰어 저장 플로우 공유 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - putContent 첫 저장 분기: fileId 없는 텍스트 파일을 열고 #fvSave를
 *   누르면 deps.createSave가 불리고, 성공하면 상태가 'saved'가 되고
 *   onSaved가 불린다 (네트워크 없이 file.bytes로 연다).
 * - saveAsContent 공유: createSave가 실패(취소)하면 file.name이 원래
 *   이름으로 되돌아간다 (runCreateSave의 restoreName 계약).
 * - putContent의 기존 파일 경로는 그대로다 (PUT + base_version, 409면
 *   dirty로 남는다).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/finder-codec.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const viewer = require('../../public/js/finder-viewer.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/finder-format-text.js')
import { TextDecoder, TextEncoder } from 'util'

// jsdom 샌드박스에는 TextEncoder/TextDecoder 전역이 없다 — 코덱이
// 호출 시점에 쓰므로 Node의 것을 채운다 (브라우저에는 내장).
const g = globalThis as any
if (!g.TextEncoder) g.TextEncoder = TextEncoder
if (!g.TextDecoder) g.TextDecoder = TextDecoder

const doc: any = (globalThis as any).document
const win: any = (globalThis as any).window

function buildDom() {
  doc.body.innerHTML = `
    <div id="finderViewer" hidden>
      <div id="fvChrome"></div>
      <span id="fvName"></span><span id="fvNote"></span>
      <button id="fvSave" hidden>저장</button>
      <a id="fvDownload" hidden></a>
      <button id="fvClose"></button>
      <div id="fvBody"></div>
      <span id="fvStatus"></span>
    </div>`
}

async function flush(times = 15) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('F-L15 runCreateSave 공유', () => {
  test('첫 저장: #fvSave 클릭이 createSave로 가고 saved가 된다', async () => {
    buildDom()
    const createSaveCalls: any[] = []
    let savedCount = 0
    const states: string[] = []
    const v = viewer.createViewer({
      doc,
      createSave: async (blob: Blob, file: any) => {
        createSaveCalls.push({ blob, file })
        file.fileId = 7
        return true
      },
      onSaved: () => savedCount++,
      onSaveStateChange: (s: string) => states.push(s),
    })
    const bytes = new TextEncoder().encode('hello world').buffer
    await v.open({ name: 'a.txt', fileId: null, bytes })
    await flush()
    // 텍스트 에디터가 열렸다
    expect(doc.querySelector('#fvBody textarea')).not.toBeNull()
    doc.getElementById('fvSave').click()
    await flush()
    expect(createSaveCalls).toHaveLength(1)
    // jsdom Blob에는 .text()가 없어 FileReader로 읽는다
    const savedText = await new Promise<string>((resolve, reject) => {
      const fr = new win.FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('blob read failed'))
      fr.readAsText(createSaveCalls[0].blob)
    })
    expect(savedText).toBe('hello world')
    expect(savedCount).toBe(1)
    expect(states[states.length - 1]).toBe('saved')
    expect(doc.getElementById('fvStatus').textContent).toContain('저장했습니다')
  })

  test('saveAsContent 실패 시 원래 이름으로 되돌아간다', async () => {
    buildDom()
    let capturedCtx: any = null
    viewer.registerFormat('csv', (ctx: any) => {
      capturedCtx = ctx
      return Promise.resolve()
    })
    const v = viewer.createViewer({
      doc,
      createSave: async () => false,
    })
    await v.open({ name: 'orig.csv', fileId: 5, bytes: new Uint8Array([1]).buffer })
    await flush()
    expect(capturedCtx).not.toBeNull()
    const ok = await capturedCtx.saveAsContent(new Blob(['x']), 'new.csv')
    expect(ok).toBe(false)
    expect(capturedCtx.file.name).toBe('orig.csv')
  })

  test('기존 파일 putContent는 PUT + base_version 경로 그대로다', async () => {
    buildDom()
    const putCalls: any[] = []
    const v = viewer.createViewer({
      doc,
      fetchFn: async (url: string, opts: any) => {
        putCalls.push({ url, opts })
        return { ok: true, status: 200, json: async () => ({ version: 9 }) }
      },
    })
    let capturedCtx: any = null
    viewer.registerFormat('csv', (ctx: any) => {
      capturedCtx = ctx
      return Promise.resolve()
    })
    await v.open({
      name: 'b.csv',
      fileId: 5,
      version: 3,
      bytes: new Uint8Array([1]).buffer,
    })
    await flush()
    const ok = await capturedCtx.putContent(new Blob(['y']))
    expect(ok).toBe(true)
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].url).toBe('/api/drive/files/5/content')
    expect(putCalls[0].opts.method).toBe('PUT')
    const fd = putCalls[0].opts.body as FormData
    expect(fd.get('base_version')).toBe('3')
    expect(capturedCtx.file.version).toBe(9)
  })
})
