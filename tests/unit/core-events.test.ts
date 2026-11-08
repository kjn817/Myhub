/// <reference types="jest" />
/**
 * src/events.ts 단위 테스트 (in-process pub/sub 이벤트 버스)
 * - on: 핸들러 등록 + 구독 해제 함수 반환
 * - emit: 페이로드 전달, 리스너 없음, 핸들러 예외 격리, 비동기 핸들러 대기
 *
 * 모듈 상태(listeners Map)가 테스트 간 공유되므로 이벤트 이름은 테스트별 고유하게 사용.
 */
import { on, emit } from '../../src/events'

describe('on / emit', () => {
  test('등록된 핸들러가 페이로드를 받는다', async () => {
    const seen: any[] = []
    const off = on('core-events-test.basic', (p) => { seen.push(p) })
    await emit('core-events-test.basic', { a: 1 })
    expect(seen).toEqual([{ a: 1 }])
    off()
  })

  test('payload 없이 emit해도 핸들러가 호출된다', async () => {
    let called = 0
    const off = on('core-events-test.no-payload', () => { called++ })
    await emit('core-events-test.no-payload')
    expect(called).toBe(1)
    off()
  })

  test('여러 핸들러가 모두 호출된다', async () => {
    const order: number[] = []
    const off1 = on('core-events-test.multi', () => { order.push(1) })
    const off2 = on('core-events-test.multi', () => { order.push(2) })
    await emit('core-events-test.multi', null)
    expect(order).toEqual([1, 2])
    off1(); off2()
  })

  test('같은 이벤트에 두 번째 on은 기존 Set을 재사용한다 (set 분기)', async () => {
    let n = 0
    const off1 = on('core-events-test.reuse', () => { n += 1 })
    const off2 = on('core-events-test.reuse', () => { n += 10 })
    await emit('core-events-test.reuse')
    expect(n).toBe(11)
    off1(); off2()
  })

  test('구독 해제 후에는 핸들러가 호출되지 않는다', async () => {
    let n = 0
    const off = on('core-events-test.off', () => { n++ })
    off()
    await emit('core-events-test.off')
    expect(n).toBe(0)
  })

  test('리스너가 없는 이벤트 emit은 조용히 종료된다', async () => {
    await expect(emit('core-events-test.never-registered', { x: 1 })).resolves.toBeUndefined()
  })

  test('모든 핸들러 해제 후 emit은 조용히 종료된다 (set.size === 0 분기)', async () => {
    const off = on('core-events-test.empty-set', () => {})
    off()
    await expect(emit('core-events-test.empty-set')).resolves.toBeUndefined()
  })

  test('핸들러가 throw해도 다른 핸들러는 실행되고 emit은 resolve된다', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const ran: string[] = []
    const off1 = on('core-events-test.throw', () => { throw new Error('boom') })
    const off2 = on('core-events-test.throw', () => { ran.push('second') })
    await emit('core-events-test.throw', 42)
    expect(ran).toEqual(['second'])
    expect(errSpy).toHaveBeenCalled()
    const firstArg = String(errSpy.mock.calls[0][0])
    expect(firstArg).toContain('core-events-test.throw')
    errSpy.mockRestore()
    off1(); off2()
  })

  test('비동기 핸들러를 기다린다', async () => {
    const order: string[] = []
    const off = on('core-events-test.async', async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push('handler')
    })
    await emit('core-events-test.async')
    order.push('after')
    expect(order).toEqual(['handler', 'after'])
    off()
  })

  test('비동기 핸들러의 반환값도 기다린다 (Promise.all)', async () => {
    let done = false
    const off = on('core-events-test.async2', () =>
      new Promise<void>((resolve) => setTimeout(() => { done = true; resolve() }, 5))
    )
    await emit('core-events-test.async2')
    expect(done).toBe(true)
    off()
  })
})
