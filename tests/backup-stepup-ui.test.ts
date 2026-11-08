/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 백업 발급 step-up 프론트 흐름 테스트 (트랙 1)
 *
 * public/js/step-up.js의 실제 행동을 jsdom + fetch 모의로 검증한다:
 * - 발급 403 STEP_UP_REQUIRED → PIN 모달 → POST /api/auth/step-up → 원래 요청 재시도 → 200
 * - PIN 취소 → step-up 호출 없이 원래 403 반환
 * - PIN_INVALID → 모달 재표시 후 올바른 PIN으로 성공
 * - backup.html 배선: step-up.js 로드 + _fetchStepUp 사용
 *
 * 카나리아: step-up.js에서 재시도나 /api/auth/step-up 호출을 제거하면
 * 성공 케이스들이 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STEPUP_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'step-up.js'), 'utf-8')
const BACKUP_HTML = fs.readFileSync(path.join(ROOT, 'public', 'backup.html'), 'utf-8')
// 발급 로직은 F3에서 backup.html 인라인에서 js/backup.js로 추출됐다
// (BACKUP_CSP script-src 'self' enforce 대응) — 배선 검증은 그쪽을 본다.
const BACKUP_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'backup.js'), 'utf-8')

function fakeRes(status: number, bodyObj: any) {
  const res: any = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => bodyObj,
    clone() {
      return fakeRes(status, bodyObj)
    },
  }
  return res
}

async function waitFor(cond: () => boolean, label: string) {
  for (let i = 0; i < 50; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timeout: ' + label)
}

const doc = () => (globalThis as any).document
const win = () => (globalThis as any).window

function loadStepUp() {
  doc().head.innerHTML = ''
  doc().body.innerHTML = ''
  // eslint-disable-next-line no-eval
  eval(STEPUP_JS)
}

async function fillPinAndConfirm(pin: string) {
  await waitFor(() => !!doc().querySelector('.pin-prompt-input'), 'PIN 모달 표시')
  const input: any = doc().querySelector('.pin-prompt-input')
  input.value = pin
  input.dispatchEvent(new (win().Event)('input', { bubbles: true }))
  doc().querySelector('.confirm-yes').click()
}

describe('step-up.js — _fetchStepUp 흐름', () => {
  const realFetch = (globalThis as any).fetch

  afterEach(() => {
    ;(globalThis as any).fetch = realFetch
    doc().body.innerHTML = ''
  })

  test('403 STEP_UP_REQUIRED → PIN 입력 → step-up 발급 → 재시도 200', async () => {
    const calls: { url: string; body: any }[] = []
    let backupAttempts = 0
    ;(globalThis as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined })
      if (url === '/api/backup/encrypted') {
        backupAttempts++
        return backupAttempts === 1
          ? fakeRes(403, { ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' })
          : fakeRes(200, { format_version: 1 })
      }
      if (url === '/api/auth/step-up') return fakeRes(200, { ok: true, stepUpUntil: Date.now() + 300000 })
      throw new Error('unexpected url ' + url)
    })
    loadStepUp()

    const promise = win()._fetchStepUp('/api/backup/encrypted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    })
    await fillPinAndConfirm('135790')
    const res = await promise

    expect(res.status).toBe(200)
    expect(backupAttempts).toBe(2)
    const stepUpCall = calls.find((c) => c.url === '/api/auth/step-up')
    expect(stepUpCall).toBeTruthy()
    expect(stepUpCall!.body).toEqual({ pin: '135790' })
    // 모달은 닫혔다
    expect(doc().querySelector('.pin-prompt-input')).toBeNull()
  })

  test('PIN 취소 → step-up 호출 없이 원래 403 반환', async () => {
    const urls: string[] = []
    ;(globalThis as any).fetch = jest.fn(async (url: string) => {
      urls.push(url)
      return fakeRes(403, { ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' })
    })
    loadStepUp()

    const promise = win()._fetchStepUp('/api/backup/encrypted', { method: 'POST' })
    await waitFor(() => !!doc().querySelector('.pin-prompt-input'), 'PIN 모달 표시')
    doc().querySelector('.confirm-no').click()
    const res = await promise

    expect(res.status).toBe(403)
    expect(urls).toEqual(['/api/backup/encrypted']) // step-up·재시도 없음
  })

  test('PIN_INVALID → 모달 재표시 → 올바른 PIN으로 재시도 성공', async () => {
    let stepUpAttempts = 0
    let backupAttempts = 0
    ;(globalThis as any).fetch = jest.fn(async (url: string) => {
      if (url === '/api/backup/encrypted') {
        backupAttempts++
        return backupAttempts === 1
          ? fakeRes(403, { ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' })
          : fakeRes(200, { format_version: 1 })
      }
      if (url === '/api/auth/step-up') {
        stepUpAttempts++
        return stepUpAttempts === 1
          ? fakeRes(403, { ok: false, error: 'pin_invalid', code: 'PIN_INVALID' })
          : fakeRes(200, { ok: true })
      }
      throw new Error('unexpected url ' + url)
    })
    loadStepUp()

    const promise = win()._fetchStepUp('/api/backup/encrypted', { method: 'POST' })
    await fillPinAndConfirm('000000')
    await fillPinAndConfirm('135790')
    const res = await promise

    expect(res.status).toBe(200)
    expect(stepUpAttempts).toBe(2)
    expect(backupAttempts).toBe(2)
  })

  test('403이지만 STEP_UP_REQUIRED가 아니면 모달 없이 그대로 반환', async () => {
    ;(globalThis as any).fetch = jest.fn(async () =>
      fakeRes(403, { error: '백업 API를 사용할 수 없는 환경입니다' })
    )
    loadStepUp()
    const res = await win()._fetchStepUp('/api/backup/encrypted', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(doc().querySelector('.pin-prompt-input')).toBeNull()
  })
})

describe('backup.html 배선', () => {
  test('step-up.js를 로드하고 발급에 _fetchStepUp을 쓴다', () => {
    expect(BACKUP_HTML).toContain('/js/step-up.js')
    expect(BACKUP_HTML).toContain('/js/backup.js')
    expect(BACKUP_JS).toContain('_fetchStepUp')
    expect(BACKUP_JS).toContain("'/api/backup/encrypted'")
  })
})
