/// <reference types="jest" />
/**
 * 새 원격 탭 만들기 — CDP Target.createTarget (2026-11-26 실제
 * 브라우저 탭 동작).
 *
 * 배경: 셸 탭에 원격 타깃이 없어 이동이 서버 활성 탭(뉴스 탭)의
 * 페이지를 덮어버렸다. POST /api/browse/tab/new는 이 함수를 써서
 * 새 원격 탭을 만들고 id를 돌려준다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - Target.createTarget을 about:blank로 부르고 받은 targetId를
 *   돌려준다 (URL을 함께 만들지 않는다 — 이동은 /navigate가 맡는다).
 * - createTarget이 CDP error를 돌려주면 ok:false, stage:'create'.
 * - 연결이 안 되면 ok:false, stage:'connect'.
 *
 * 카나리아: createTarget 호출·targetId 파싱을 지우면 1번이,
 * error 분기를 지우면 2번이 실패한다 (수동 실증).
 */
import { createTabSession, type CdpConnectFn, type CdpSocket } from '../src/modules/browse/cdp'

function replyingSocket(reply: (msg: { id: number; method: string }) => unknown): CdpConnectFn {
  let listener: ((ev: { data: unknown }) => void) | null = null
  const sock: CdpSocket = {
    send(data: string): void {
      const msg = JSON.parse(data) as { id: number; method: string }
      const result = reply(msg)
      queueMicrotask(() => {
        listener?.({ data: JSON.stringify({ id: msg.id, result }) })
      })
    },
    close(): void {},
    addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      listener = cb
    },
  }
  return async () => sock
}

describe('createTabSession', () => {
  test('Target.createTarget을 about:blank로 부르고 targetId를 돌려준다', async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
    const connect = replyingSocket((msg) => {
      sent.push({ method: msg.method, params: msg.params as Record<string, unknown> | undefined })
      return { targetId: 'page-mock-1' }
    })
    const res = await createTabSession('wss://example.invalid/devtools/page/1', connect, {
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(true)
    expect(res.stage).toBe('ok')
    expect(res.targetId).toBe('page-mock-1')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('Target.createTarget')
    expect(sent[0].params).toEqual({ url: 'about:blank' })
  })

  test('createTarget이 CDP error를 돌려주면 ok:false, stage:create', async () => {
    let listener: ((ev: { data: unknown }) => void) | null = null
    const sock: CdpSocket = {
      send(data: string): void {
        const msg = JSON.parse(data) as { id: number; method: string }
        queueMicrotask(() => {
          listener?.({
            data: JSON.stringify({ id: msg.id, error: { message: 'no target' } }),
          })
        })
      },
      close(): void {},
      addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
        listener = cb
      },
    }
    const connect: CdpConnectFn = async () => sock
    const res = await createTabSession('wss://example.invalid/devtools/page/1', connect, {
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.stage).toBe('create')
    expect(res.targetId).toBeUndefined()
  })

  test('연결이 안 되면 ok:false, stage:connect', async () => {
    const connect: CdpConnectFn = async () => null
    const res = await createTabSession('wss://example.invalid/devtools/page/1', connect, {
      timeoutMs: 5000,
    })
    expect(res.ok).toBe(false)
    expect(res.stage).toBe('connect')
  })
})
