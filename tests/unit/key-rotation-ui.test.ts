/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 키 로테이션 페이지 UI 검증 (트랙 5 — backup-restore.md §12.2 census 계약)
 *
 * 검증 성질:
 * - dry-run pending이 기준 census(메모 본문 4·블록 0·Google 1·잠긴 첨부 0)와
 *   전 항목 일치할 때만 실행 버튼이 활성화된다. 불일치하면 활성화되지
 *   않는다 (카나리아: 대조 로직을 전 항목이 아닌 일부로 약화하면
 *   '불일치' 케이스가 깨진다).
 * - 발급이 403 STEP_UP_REQUIRED면 공용 step-up 모달이 뜨고, PIN 입력 후
 *   step-up을 거쳐 원래 요청이 재시도된다.
 * - 실행 성공 후 rotated == pending를 확인하고 입력란의 키 값을 비운다.
 * - 값 미저장: key-rotation.js는 localStorage·sessionStorage·cookie·
 *   콘솔 출력을 일절 쓰지 않는다 (정적 검사로 고정).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'key-rotation.html'), 'utf-8')
const STEPUP_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'step-up.js'), 'utf-8')
const ROTATION_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'key-rotation.js'), 'utf-8')

const CENSUS = { memo_text: 4, memo_block: 0, google_token_row: 1, locked_file: 0 }
const ZEROS = { memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 0 }
const NEW_KEY = 'test-new-key-value-not-a-real-secret-0123456789'

type FetchImpl = (url: string, opts: any) => Promise<any>

function jsonRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() { return this },
  }
}

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function setup(fetchImpl: FetchImpl) {
  const bodyHtml = HTML.split('<body>')[1].split('</body>')[0].replace(/<script[\s\S]*?<\/script>/g, '')
  getDoc().body.innerHTML = bodyHtml
  ;(globalThis as any).fetch = jest.fn(fetchImpl)
  ;getWin().fetch = (globalThis as any).fetch
  new Function('window', 'document', STEPUP_JS)(getWin(), getDoc())
  new Function('window', 'document', ROTATION_JS)(getWin(), getDoc())
  ;(getDoc().getElementById('newKey') as any).value = NEW_KEY
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const executeBtn = () => getDoc().getElementById('executeBtn') as any

describe('키 로테이션 페이지', () => {
  test('dry-run 일치 → 실행 활성화, 실행 후 rotated 확인 + 입력란 비움 + 경고 표시', async () => {
    setup(async (url: string, opts: any) => {
      const body = JSON.parse(opts.body)
      if (body.dryRun) return jsonRes(200, { ok: true, dryRun: true, mode: 'rotate', pending: CENSUS, already: ZEROS, rotated: ZEROS, warnings: [] })
      return jsonRes(200, { ok: true, dryRun: false, mode: 'rotate', pending: CENSUS, already: ZEROS, rotated: CENSUS, warnings: [] })
    })
    await getWin().krDryRun()
    expect(executeBtn().disabled).toBe(false)
    expect(getDoc().getElementById('censusTable')!.style.display).toBe('table')
    await getWin().krExecute()
    expect(getDoc().getElementById('successBox')!.textContent).toContain('로테이션 완료')
    expect(getDoc().getElementById('warnBox')!.classList.contains('show')).toBe(true)
    expect(getDoc().getElementById('warnBox')!.textContent).toContain('MEMO_ENCRYPTION_KEY')
    expect((getDoc().getElementById('newKey') as any).value).toBe('')
  })

  test('dry-run 불일치 (메모 본문 3건) → 실행 버튼이 활성화되지 않는다 (fail-closed 카나리아)', async () => {
    setup(async () => jsonRes(200, {
      ok: true, dryRun: true, mode: 'rotate',
      pending: { ...CENSUS, memo_text: 3 }, already: ZEROS, rotated: ZEROS, warnings: [],
    }))
    await getWin().krDryRun()
    expect(executeBtn().disabled).toBe(true)
    expect(getDoc().getElementById('errorBox')!.textContent).toContain('fail-closed')
    expect(getDoc().querySelectorAll('#censusBody tr.mismatch').length).toBe(1)
  })

  test('dry-run preflight 실패 (ok:false) → 실행 불가 + 실패 건수 표시', async () => {
    setup(async () => jsonRes(200, {
      ok: false, dryRun: true, mode: 'rotate', stage: 'preflight',
      error: 'decrypt failed', failures: { memo_text: 1 }, warnings: [],
    }))
    await getWin().krDryRun()
    expect(executeBtn().disabled).toBe(true)
    expect(getDoc().getElementById('errorBox')!.textContent).toContain('메모 본문 1건')
  })

  test('step-up 필요 시 PIN 모달 → step-up → 재시도로 dry-run이 완주한다', async () => {
    let rotateCalls = 0
    setup(async (url: string) => {
      if (url === '/api/auth/step-up') return jsonRes(200, { ok: true })
      rotateCalls++
      if (rotateCalls === 1) return jsonRes(403, { ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' })
      return jsonRes(200, { ok: true, dryRun: true, mode: 'rotate', pending: CENSUS, already: ZEROS, rotated: ZEROS, warnings: [] })
    })
    const p = getWin().krDryRun()
    await tick()
    const input = getDoc().querySelector('.pin-prompt-input') as any
    expect(input).not.toBeNull()
    input.value = '123456'
    ;(getDoc().querySelector('.confirm-yes') as any).click()
    await p
    expect(rotateCalls).toBe(2)
    expect(executeBtn().disabled).toBe(false)
  })

  test('값 미저장 정적 검사: 로테이션 JS는 저장소·쿠키·콘솔 API를 호출하지 않고, 입력란은 password + autocomplete=off', () => {
    // 주석의 단어 언급이 아니라 실제 API 호출 패턴의 부재를 검증한다
    expect(ROTATION_JS).not.toMatch(/localStorage\s*[.[]/)
    expect(ROTATION_JS).not.toMatch(/sessionStorage\s*[.[]/)
    expect(ROTATION_JS).not.toMatch(/document\.cookie\s*=[^=]/)
    expect(ROTATION_JS).not.toMatch(/console\s*\.\s*(log|info|warn|error|debug)\s*\(/)
    const inputTag = HTML.match(/<input[^>]*id="newKey"[^>]*>/)?.[0] ?? ''
    expect(inputTag).toContain('type="password"')
    expect(inputTag).toContain('autocomplete="off"')
  })
})
