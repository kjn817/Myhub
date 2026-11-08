/// <reference types="jest" />
/**
 * src/services/ai-key-pool-store.ts — 키 풀 영속 문서·SHA-256 성질 테스트.
 *
 * sha256Hex는 Node 내장 crypto라는 독립 구현과 대조해 검증한다(빈 입력·
 * 다중 블록·유니코드). loadDoc은 "없거나 깨졌으면 빈 문서, KV 장애는 throw"
 * 라는 fail-soft 계약의 경계를 고정한다.
 * 카나리아: loadDoc의 깨진 JSON 처리(catch)를 지우면 '깨진 JSON' 케이스가 실패한다.
 */
import { createHash } from 'node:crypto'
import {
  KvKeyPoolStore,
  emptyKeyPoolDoc,
  hashApiKey,
  keyPoolDocKey,
  sha256Hex,
  type KeyPoolDoc,
} from '../../src/services/ai-key-pool-store'

describe('sha256Hex — 독립 구현(crypto)과 일치', () => {
  test('표준 테스트 벡터', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test.each([
    ['a'.repeat(55)],
    ['a'.repeat(56)], // 패딩 경계 (길이 필드가 다음 블록으로 넘어가는 지점)
    ['a'.repeat(64)],
    ['a'.repeat(65)],
    ['a'.repeat(200)], // 다중 블록
    ['한글 키 값 테스트'],
    ['🔑 emoji key'],
    ['sk-live-abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('crypto와 일치: %s...', (input) => {
    const expected = createHash('sha256').update(input, 'utf8').digest('hex')
    expect(sha256Hex(input)).toBe(expected)
  })
})

describe('hashApiKey', () => {
  test('sha256 앞 32 hex 문자이며 결정적이다', () => {
    const h = hashApiKey('my-secret-key')
    expect(h).toBe(sha256Hex('my-secret-key').slice(0, 32))
    expect(h).toHaveLength(32)
    expect(hashApiKey('my-secret-key')).toBe(h)
    expect(hashApiKey('my-secret-key-2')).not.toBe(h)
  })
})

describe('emptyKeyPoolDoc / keyPoolDocKey', () => {
  test('빈 문서 형태와 독립성', () => {
    const a = emptyKeyPoolDoc()
    expect(a).toEqual({ v: 1, keys: {}, revoked: {} })
    a.keys.x = { failures: 1, cooledUntil: 2 }
    expect(emptyKeyPoolDoc().keys).toEqual({})
  })

  test('문서 키는 프로바이더를 포함한다', () => {
    expect(keyPoolDocKey('gemini')).toBe('ai-key-pool:v1:gemini')
    expect(keyPoolDocKey('groq')).not.toBe(keyPoolDocKey('gemini'))
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

describe('KvKeyPoolStore.loadDoc', () => {
  test('문서가 없으면 빈 문서', async () => {
    const store = new KvKeyPoolStore(fakeKv() as unknown as KVNamespace)
    await expect(store.loadDoc('gemini')).resolves.toEqual({ v: 1, keys: {}, revoked: {} })
  })

  test('깨진 JSON은 빈 문서로 취급한다 (throw 아님)', async () => {
    const store = new KvKeyPoolStore(
      fakeKv({ 'ai-key-pool:v1:gemini': '{not json' }) as unknown as KVNamespace,
    )
    await expect(store.loadDoc('gemini')).resolves.toEqual({ v: 1, keys: {}, revoked: {} })
  })

  test.each([['null'], ['123'], ['"str"'], ['true']])(
    '객체가 아닌 JSON(%s)은 빈 문서',
    async (raw) => {
      const store = new KvKeyPoolStore(
        fakeKv({ 'ai-key-pool:v1:gemini': raw }) as unknown as KVNamespace,
      )
      await expect(store.loadDoc('gemini')).resolves.toEqual({ v: 1, keys: {}, revoked: {} })
    },
  )

  test('keys/revoked가 객체가 아니면 기본값으로 대체한다', async () => {
    const store = new KvKeyPoolStore(
      fakeKv({
        'ai-key-pool:v1:gemini': JSON.stringify({ keys: null, revoked: 'x' }),
      }) as unknown as KVNamespace,
    )
    await expect(store.loadDoc('gemini')).resolves.toEqual({ v: 1, keys: {}, revoked: {} })
  })

  test('저장된 v가 달라도 로드 시 v는 1로 정규화된다', async () => {
    const store = new KvKeyPoolStore(
      fakeKv({
        'ai-key-pool:v1:gemini': JSON.stringify({ v: 99, keys: {}, revoked: {} }),
      }) as unknown as KVNamespace,
    )
    await expect(store.loadDoc('gemini')).resolves.toMatchObject({ v: 1 })
  })

  test('KV get이 throw하면 그대로 전파된다 (호출자 fail-soft 계약)', async () => {
    const kv = {
      get: async () => {
        throw new Error('kv down')
      },
      put: async () => {},
    }
    const store = new KvKeyPoolStore(kv as unknown as KVNamespace)
    await expect(store.loadDoc('gemini')).rejects.toThrow('kv down')
  })
})

describe('KvKeyPoolStore save→load 왕복', () => {
  test('저장한 문서가 그대로 돌아온다', async () => {
    const kv = fakeKv()
    const store = new KvKeyPoolStore(kv as unknown as KVNamespace)
    const doc: KeyPoolDoc = {
      v: 1,
      keys: { abc: { failures: 3, cooledUntil: 12345 } },
      revoked: { 'gemini-2.5-flash': ['deadbeef'] },
    }
    await store.saveDoc('gemini', doc)
    expect(kv.map.get('ai-key-pool:v1:gemini')).toBe(JSON.stringify(doc))
    await expect(store.loadDoc('gemini')).resolves.toEqual(doc)
    // 다른 프로바이더 문서는 비어 있다
    await expect(store.loadDoc('groq')).resolves.toEqual({ v: 1, keys: {}, revoked: {} })
  })
})
