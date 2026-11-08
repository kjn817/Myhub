/// <reference types="jest" />
/**
 * src/services/ai-key-pool.ts — 키 풀 선택·자격 박탈·KV 영속 성질 테스트.
 *
 * 모듈 전역 상태(Map/WeakMap)를 쓰므로 각 테스트는 resetModules로 격리한다.
 * 핵심 성질: ① 쿨다운 중이거나 최소 실패 티어가 아닌 키는 절대 선택되지
 * 않는다 ② 모델 allowlist·revoke는 해당 모델에만 적용된다 ③ 영속 상태는
 * hydrate 시 max 병합되고, KV 장애는 fail-soft(throw 금지)다.
 * 카나리아: pickKey의 쿨다운 필터(<=)를 (<)로 바꾸거나 revoke의 allowlist
 * 초기화를 지우면 실패한다.
 */
import { hashApiKey } from '../../src/services/ai-key-pool-store'

type PoolModule = typeof import('../../src/services/ai-key-pool')

async function freshModule(): Promise<PoolModule> {
  jest.resetModules()
  return import('../../src/services/ai-key-pool')
}

function ks(key: string, failures = 0, cooledUntil = 0) {
  return { key, failures, cooledUntil } as { key: string; failures: number; cooledUntil: number }
}

const NOW_PAST = Date.now() - 60_000
const FUTURE = Date.now() + 60_000

describe('pickKey', () => {
  test('빈 풀이면 null', async () => {
    const m = await freshModule()
    expect(m.pickKey([])).toBeNull()
  })

  test('전부 쿨다운이면 null', async () => {
    const m = await freshModule()
    expect(m.pickKey([ks('a', 0, FUTURE), ks('b', 0, FUTURE)])).toBeNull()
  })

  test('쿨다운이 지난 키는 선택 가능하고, 쿨다운 중인 키는 실패가 적어도 제외된다', async () => {
    const m = await freshModule()
    const cooled = ks('cooled', 0, FUTURE)
    const free = ks('free', 9, NOW_PAST)
    for (let i = 0; i < 20; i++) expect(m.pickKey([cooled, free])).toBe(free)
  })

  test('최소 실패 티어 안에서만 선택된다', async () => {
    const m = await freshModule()
    const a = ks('a', 2)
    const b = ks('b', 0)
    const c = ks('c', 0)
    const seen = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const picked = m.pickKey([a, b, c])
      expect(picked).not.toBeNull()
      expect(picked?.failures).toBe(0)
      seen.add(picked!.key)
    }
    expect(seen).toEqual(new Set(['b', 'c'])) // 티어 내에서는 실제로 분산된다
  })
})

describe('pickKeyForModel / revokeKeyForModel', () => {
  test('gemini-2.5-flash는 인덱스 0 키만 허용한다', async () => {
    const m = await freshModule()
    const pool = [ks('k0'), ks('k1'), ks('k2')]
    for (let i = 0; i < 20; i++) expect(m.pickKeyForModel(pool as never, 'gemini-2.5-flash')).toBe(pool[0])
  })

  test('allowlist 키가 쿨다운이면 다른 키로 새지 않고 null', async () => {
    const m = await freshModule()
    const pool = [ks('k0', 0, FUTURE), ks('k1'), ks('k2')]
    expect(m.pickKeyForModel(pool as never, 'gemini-2.5-flash')).toBeNull()
  })

  test('미등록 모델은 풀 전체가 후보다', async () => {
    const m = await freshModule()
    const pool = [ks('k0'), ks('k1')]
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) seen.add(m.pickKeyForModel(pool as never, 'some-new-model')!.key)
    expect(seen).toEqual(new Set(['k0', 'k1']))
  })

  test('revoke한 키는 그 모델에서만 제외되고 다른 모델은 영향 없다', async () => {
    const m = await freshModule()
    const pool = [ks('k0'), ks('k1'), ks('k2')]
    m.revokeKeyForModel(pool as never, 'm1', pool[1] as never)
    for (let i = 0; i < 40; i++) {
      expect(m.pickKeyForModel(pool as never, 'm1')?.key).not.toBe('k1')
    }
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) seen.add(m.pickKeyForModel(pool as never, 'm2')!.key)
    expect(seen.has('k1')).toBe(true)
  })

  test('allowlist가 있던 모델에서 유일 키를 revoke하면 null이 된다', async () => {
    const m = await freshModule()
    const pool = [ks('k0'), ks('k1')]
    m.revokeKeyForModel(pool as never, 'gemini-2.5-flash', pool[0] as never)
    expect(m.pickKeyForModel(pool as never, 'gemini-2.5-flash')).toBeNull()
  })

  test('풀에 없는 키를 revoke하면 아무 일도 일어나지 않는다', async () => {
    const m = await freshModule()
    const pool = [ks('k0'), ks('k1')]
    const outsider = ks('outsider')
    expect(() => m.revokeKeyForModel(pool as never, 'm1', outsider as never)).not.toThrow()
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) seen.add(m.pickKeyForModel(pool as never, 'm1')!.key)
    expect(seen).toEqual(new Set(['k0', 'k1']))
  })
})

describe('getPool — env에서 풀 구축', () => {
  test('gemini 키가 일부만 있어도 있는 것만 순서대로 담긴다', async () => {
    const m = await freshModule()
    const env = { GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_3: 'g3' }
    const pool = m.getPool(env as never, 'gemini')
    expect(pool.map((k) => k.key)).toEqual(['g1', 'g3'])
    expect(pool[0]).toMatchObject({ failures: 0, cooledUntil: 0 })
  })

  test('같은 프로바이더는 같은 배열을 재사용한다 (캐시)', async () => {
    const m = await freshModule()
    const env = { GEMINI_API_KEY_1: 'g1' }
    expect(m.getPool(env as never, 'gemini')).toBe(m.getPool(env as never, 'gemini'))
  })

  test('groq·nvidia도 각 접두사로 구축되고, 키 없는 프로바이더는 빈 풀', async () => {
    const m = await freshModule()
    const env = { GROQ_API_KEY_2: 'q2', NVIDIA_API_KEY_1: 'n1' }
    expect(m.getPool(env as never, 'groq').map((k) => k.key)).toEqual(['q2'])
    expect(m.getPool(env as never, 'nvidia').map((k) => k.key)).toEqual(['n1'])
    expect(m.getPool(env as never, 'workers-ai')).toEqual([])
    expect(m.getPool({} as never, 'gemini')).toEqual([])
  })
})

function fakeKv(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

describe('KV 영속 — hydrate/persist', () => {
  test('hydrate는 저장된 실패·쿨다운을 max로 병합하고 revoked를 반영한다', async () => {
    const m = await freshModule()
    const doc = {
      v: 1,
      keys: { [hashApiKey('g1')]: { failures: 3, cooledUntil: FUTURE } },
      revoked: { 'other-model': [hashApiKey('g2')] },
    }
    const kv = fakeKv({ 'ai-key-pool:v1:gemini': JSON.stringify(doc) })
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_2: 'g2' }
    const pool = m.getPool(env as never, 'gemini')
    await m.hydrateKeyPool(env as never, 'gemini')
    expect(pool[0].failures).toBe(3)
    expect(pool[0].cooledUntil).toBe(FUTURE)
    // revoked된 g2는 other-model에서 제외 → 쿨다운 중인 g1만 남는다가 아니라,
    // g1은 쿨다운이라 선택 불가이므로 null이어야 한다
    expect(m.pickKeyForModel(pool, 'other-model')).toBeNull()
    // revoked가 없는 모델에서는 쿨다운이 풀린 뒤 g2가 선택된다
    pool[0].cooledUntil = 0
    pool[0].failures = 0
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) seen.add(m.pickKeyForModel(pool, 'unrelated')!.key)
    expect(seen).toEqual(new Set(['g1', 'g2']))
  })

  test('상태를 바꾸면 flush 후 KV 문서에 반영되고, 정상으로 되돌리면 항목이 사라진다', async () => {
    const m = await freshModule()
    const kv = fakeKv()
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1' }
    const pool = m.getPool(env as never, 'gemini')
    await m.hydrateKeyPool(env as never, 'gemini')

    pool[0].failures = 5
    await m.flushKeyPoolPersistence()
    let saved = JSON.parse(kv.map.get('ai-key-pool:v1:gemini')!)
    expect(saved.keys[hashApiKey('g1')]).toEqual({ failures: 5, cooledUntil: 0 })

    pool[0].failures = 0
    await m.flushKeyPoolPersistence()
    saved = JSON.parse(kv.map.get('ai-key-pool:v1:gemini')!)
    expect(saved.keys[hashApiKey('g1')]).toBeUndefined()
  })

  test('revoke는 flush 후 문서의 revoked에 해시로 남는다', async () => {
    const m = await freshModule()
    const kv = fakeKv()
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1', GEMINI_API_KEY_2: 'g2' }
    const pool = m.getPool(env as never, 'gemini')
    await m.hydrateKeyPool(env as never, 'gemini')
    m.revokeKeyForModel(pool, 'm1', pool[1])
    await m.flushKeyPoolPersistence()
    const saved = JSON.parse(kv.map.get('ai-key-pool:v1:gemini')!)
    expect(saved.revoked['m1']).toEqual([hashApiKey('g2')])
  })

  test('KV get 장애 시 hydrate는 throw하지 않고 기본값으로 동작한다 (fail-soft)', async () => {
    const m = await freshModule()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = {
      get: async () => {
        throw new Error('kv down')
      },
      put: async () => {},
    }
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1' }
    const pool = m.getPool(env as never, 'gemini')
    await expect(m.hydrateKeyPool(env as never, 'gemini')).resolves.toBeUndefined()
    expect(pool[0].failures).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('KV가 없으면 hydrate/flush 모두 조용히 성공한다', async () => {
    const m = await freshModule()
    const env = { GEMINI_API_KEY_1: 'g1' }
    const pool = m.getPool(env as never, 'gemini')
    await expect(m.hydrateKeyPool(env as never, 'gemini')).resolves.toBeUndefined()
    pool[0].failures = 2
    await expect(m.flushKeyPoolPersistence()).resolves.toBeUndefined()
  })

  test('saveDoc 장애 시 flush는 throw하지 않는다', async () => {
    const m = await freshModule()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = {
      get: async () => null,
      put: async () => {
        throw new Error('put failed')
      },
    }
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1' }
    const pool = m.getPool(env as never, 'gemini')
    await m.hydrateKeyPool(env as never, 'gemini')
    pool[0].failures = 1
    await expect(m.flushKeyPoolPersistence()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('같은 값을 다시 대입하면 상태가 변하지 않는다 (setter 멱등)', async () => {
    const m = await freshModule()
    const kv = fakeKv()
    const env = { KV: kv, GEMINI_API_KEY_1: 'g1' }
    const pool = m.getPool(env as never, 'gemini')
    await m.hydrateKeyPool(env as never, 'gemini')
    pool[0].failures = 4
    pool[0].failures = 4
    await m.flushKeyPoolPersistence()
    const saved = JSON.parse(kv.map.get('ai-key-pool:v1:gemini')!)
    expect(saved.keys[hashApiKey('g1')].failures).toBe(4)
  })
})
