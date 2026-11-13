/// <reference types="jest" />
/**
 * public/js/craft-clipboard.js — 붙여넣기 헬퍼 5중복 통합 코어 단위 테스트.
 *
 * 고정하는 성질 (F-L2 설계 노트 .scratch/f-l2-paste-design.md):
 * - PASTE_MAX_BYTES는 32MB (host.rs MAX_PICTURE_BYTES와 같은 상한).
 * - isFormFieldTarget: 널·비객체·일반 태그는 false, contentEditable·
 *   INPUT·TEXTAREA·SELECT는 true.
 * - pasteImageFile: files 경로 우선, 없으면 items 경로(kind=file·
 *   image/*·getAsFile), 이미지 아닌 파일은 무시, cd 없음 → null.
 *   skipTableHtml=true면 표 HTML이 있으면 null, getData throw는 무시하고
 *   계속한다. skipTableHtml이 falsy면 표 HTML이 있어도 파일을 반환한다
 *   (1인자본과 동일).
 * - fileToBase64: data: URL 접두사를 떼고 base64만 반환, 쉼표 없으면 ''.
 *   ReaderCtor 주입·window.FileReader 폴백·onerror 거절.
 * - normalizeBytes: 널 → null, ArrayBuffer는 동일 인스턴스, 뷰는 자기
 *   구간만 복사, 그 외 → null.
 * 카나리아: skipTableHtml 분기를 빼면 표 차단 테스트가, ReaderCtor
 * 폴백을 빼면 1인자 호출 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-clipboard.js'), 'utf-8')

function loadCore(opts: { win?: any; doc?: any } = {}): any {
  const win = opts.win !== undefined ? opts.win : {}
  const moduleObj: any = { exports: {} }
  const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
  fn(win, opts.doc, undefined, setTimeout, moduleObj)
  return win.MyHubCraftClipboard || moduleObj.exports
}

/** FileReader 스텁 생성자: result·error를 지정하고 readAsDataURL에서 비동기 콜백을 탄다. */
function makeReaderCtor(result: string | null, error: any = null): any {
  return class FakeReader {
    result: string | null = null
    error: any = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(): void {
      const self = this
      setTimeout(() => {
        if (error) {
          self.error = error
          if (self.onerror) self.onerror()
        } else {
          self.result = result
          if (self.onload) self.onload()
        }
      }, 0)
    }
  }
}

const PNG_FILE: any = { name: 'clipboard.png', type: 'image/png', size: 123 }
const TXT_FILE: any = { name: 'note.txt', type: 'text/plain', size: 10 }

describe('craft-clipboard-core 상수·전역', () => {
  test('PASTE_MAX_BYTES는 32MB다', () => {
    expect(loadCore().PASTE_MAX_BYTES).toBe(32 * 1024 * 1024)
  })

  test('window 전역과 module.exports에 같은 API를 노출한다', () => {
    const win: any = {}
    const moduleObj: any = { exports: {} }
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
    fn(win, undefined, undefined, setTimeout, moduleObj)
    expect(win.MyHubCraftClipboard).toBeDefined()
    expect(moduleObj.exports).toBe(win.MyHubCraftClipboard)
    expect(typeof win.MyHubCraftClipboard.pasteImageFile).toBe('function')
    expect(typeof win.MyHubCraftClipboard.fileToBase64).toBe('function')
    expect(typeof win.MyHubCraftClipboard.normalizeBytes).toBe('function')
    expect(typeof win.MyHubCraftClipboard.isFormFieldTarget).toBe('function')
  })
})

describe('craft-clipboard-core isFormFieldTarget', () => {
  const core = loadCore()
  test('널·undefined·비객체는 false', () => {
    expect(core.isFormFieldTarget(null)).toBe(false)
    expect(core.isFormFieldTarget(undefined)).toBe(false)
    expect(core.isFormFieldTarget('INPUT')).toBe(false)
    expect(core.isFormFieldTarget(42)).toBe(false)
  })
  test('contentEditable면 true', () => {
    expect(core.isFormFieldTarget({ isContentEditable: true, tagName: 'DIV' })).toBe(true)
  })
  test('INPUT·TEXTAREA·SELECT는 true', () => {
    expect(core.isFormFieldTarget({ tagName: 'INPUT' })).toBe(true)
    expect(core.isFormFieldTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(core.isFormFieldTarget({ tagName: 'SELECT' })).toBe(true)
  })
  test('일반 태그·태그 없음은 false', () => {
    expect(core.isFormFieldTarget({ tagName: 'DIV' })).toBe(false)
    expect(core.isFormFieldTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(core.isFormFieldTarget({})).toBe(false)
  })
})

describe('craft-clipboard-core pasteImageFile', () => {
  const core = loadCore()
  test('cd가 없으면 null', () => {
    expect(core.pasteImageFile(null)).toBeNull()
    expect(core.pasteImageFile(undefined)).toBeNull()
  })
  test('files에서 첫 이미지 파일을 반환하고 이미지 아닌 파일은 건너뛴다', () => {
    expect(core.pasteImageFile({ files: [TXT_FILE, PNG_FILE] })).toBe(PNG_FILE)
    expect(core.pasteImageFile({ files: [PNG_FILE] })).toBe(PNG_FILE)
  })
  test('files에 이미지가 없으면 null (items가 없어도)', () => {
    expect(core.pasteImageFile({ files: [TXT_FILE] })).toBeNull()
    expect(core.pasteImageFile({ files: [] })).toBeNull()
  })
  test('items 경로: kind=file·image/*·getAsFile만 취한다', () => {
    const item = { kind: 'file', type: 'image/jpeg', getAsFile: () => PNG_FILE }
    expect(core.pasteImageFile({ files: [], items: [item] })).toBe(PNG_FILE)
    expect(core.pasteImageFile({ items: [{ kind: 'string', type: 'image/png', getAsFile: () => PNG_FILE }] })).toBeNull()
    expect(core.pasteImageFile({ items: [{ kind: 'file', type: 'text/plain', getAsFile: () => TXT_FILE }] })).toBeNull()
    expect(core.pasteImageFile({ items: [{ kind: 'file', type: 'image/png' }] })).toBeNull()
    expect(core.pasteImageFile({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] })).toBeNull()
  })
  test('files가 items보다 우선한다', () => {
    const other: any = { name: 'items.png', type: 'image/png', size: 9 }
    const item = { kind: 'file', type: 'image/png', getAsFile: () => other }
    expect(core.pasteImageFile({ files: [PNG_FILE], items: [item] })).toBe(PNG_FILE)
  })
  test('skipTableHtml=true면 표 HTML이 있을 때 null을 반환한다', () => {
    const cd = { files: [PNG_FILE], getData: () => '<table><tr><td>x</td></tr></table>' }
    expect(core.pasteImageFile(cd, true)).toBeNull()
    const cd2 = { files: [PNG_FILE], getData: () => '<TABLE class="x">' }
    expect(core.pasteImageFile(cd2, true)).toBeNull()
  })
  test('skipTableHtml=true여도 표가 아닌 HTML이면 파일을 반환한다', () => {
    const cd = { files: [PNG_FILE], getData: () => '<p>hello</p>' }
    expect(core.pasteImageFile(cd, true)).toBe(PNG_FILE)
  })
  test('skipTableHtml=true인데 getData가 throw하면 무시하고 파일을 반환한다', () => {
    const cd = {
      files: [PNG_FILE],
      getData: () => {
        throw new Error('denied')
      },
    }
    expect(core.pasteImageFile(cd, true)).toBe(PNG_FILE)
  })
  test('skipTableHtml이 falsy면 표 HTML이 있어도 파일을 반환한다 (1인자본과 동일)', () => {
    const cd = { files: [PNG_FILE], getData: () => '<table><tr><td>x</td></tr></table>' }
    expect(core.pasteImageFile(cd)).toBe(PNG_FILE)
    expect(core.pasteImageFile(cd, false)).toBe(PNG_FILE)
  })
  test('skipTableHtml=true인데 getData 함수가 없으면 파일을 반환한다', () => {
    expect(core.pasteImageFile({ files: [PNG_FILE] }, true)).toBe(PNG_FILE)
  })
})

describe('craft-clipboard-core fileToBase64', () => {
  const core = loadCore()
  test('ReaderCtor 주입: data: URL 접두사를 떼고 base64만 반환한다', async () => {
    const b64 = await core.fileToBase64(PNG_FILE, makeReaderCtor('data:image/png;base64,QUJDRA=='))
    expect(b64).toBe('QUJDRA==')
  })
  test('결과에 쉼표가 없으면 빈 문자열을 반환한다', async () => {
    const b64 = await core.fileToBase64(PNG_FILE, makeReaderCtor('no-comma-here'))
    expect(b64).toBe('')
  })
  test('결과가 비어 있으면 빈 문자열을 반환한다', async () => {
    const b64 = await core.fileToBase64(PNG_FILE, makeReaderCtor(null))
    expect(b64).toBe('')
  })
  test('onerror면 reader.error로 거절한다', async () => {
    const err = new Error('read failed')
    await expect(core.fileToBase64(PNG_FILE, makeReaderCtor(null, err))).rejects.toBe(err)
  })
  test('onerror인데 error가 없으면 기본 메시지로 거절한다', async () => {
    const Ctor = class {
      result: any = null
      error: any = null
      onload: any = null
      onerror: any = null
      readAsDataURL(): void {
        const self = this
        setTimeout(() => {
          if (self.onerror) self.onerror()
        }, 0)
      }
    }
    await expect(core.fileToBase64(PNG_FILE, Ctor)).rejects.toThrow('파일을 읽지 못했습니다')
  })
  test('1인자 호출은 window.FileReader로 폴백한다', async () => {
    const win: any = { FileReader: makeReaderCtor('data:image/png;base64,RkFLRQ==') }
    const coreWithWin = loadCore({ win })
    const b64 = await coreWithWin.fileToBase64(PNG_FILE)
    expect(b64).toBe('RkFLRQ==')
  })
})

describe('craft-clipboard-core normalizeBytes', () => {
  const core = loadCore()
  test('널·undefined → null', () => {
    expect(core.normalizeBytes(null)).toBeNull()
    expect(core.normalizeBytes(undefined)).toBeNull()
  })
  test('ArrayBuffer는 동일 인스턴스를 반환한다', () => {
    const buf = new ArrayBuffer(8)
    expect(core.normalizeBytes(buf)).toBe(buf)
  })
  test('Uint8Array 뷰는 자기 구간만 복사해 새 ArrayBuffer로 만든다', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9])
    const view = new Uint8Array(backing.buffer, 1, 3)
    const out = core.normalizeBytes(view)
    expect(out).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]))
    // 복사본이라 원본을 바꿔도 영향을 받지 않는다
    backing[1] = 99
    expect(new Uint8Array(out)[0]).toBe(1)
  })
  test('DataView도 구간 복사한다', () => {
    const backing = new Uint8Array([7, 5, 6])
    const view = new DataView(backing.buffer, 1, 2)
    const out = core.normalizeBytes(view)
    expect(new Uint8Array(out)).toEqual(new Uint8Array([5, 6]))
  })
  test('버퍼도 뷰도 아니면 null', () => {
    expect(core.normalizeBytes({})).toBeNull()
    expect(core.normalizeBytes('bytes')).toBeNull()
    expect(core.normalizeBytes(123)).toBeNull()
    expect(core.normalizeBytes([1, 2, 3])).toBeNull()
  })
})
