// API 키 풀 (라운드로빈 + 서킷브레이커) + 모델별 키 자격 allowlist
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
// 상태(keyPools·MODEL_KEY_ALLOWLIST)는 이 모듈이 단일 소유한다.
// 키 상태(failures·cooledUntil)와 모델별 자격 박탈은 KV(ai-key-pool-store)에
// 영속한다 — 콜드스타트에도 서킷브레이커·자격 상태가 유지된다. KV가 없거나
// 장애면 메모리만으로 동작한다 (fail-soft).
import type { Env } from '../types'
import type { ProviderId } from './provider-registry'
import { KvKeyPoolStore, hashApiKey, type KeyPoolDoc } from './ai-key-pool-store'

export interface KeyState {
  key: string
  cooledUntil: number // rate limit 시 백오프
  failures: number
}

interface KeyInternal {
  failures: number
  cooledUntil: number
  hash: string
}

type BoundStore = (KvKeyPoolStore & { __kv?: unknown }) | null

const keyPools = new Map<ProviderId, KeyState[]>()
const keyInternals = new WeakMap<KeyState, KeyInternal>()
const poolProviders = new WeakMap<KeyState[], ProviderId>()
const boundStores = new Map<ProviderId, BoundStore>()
const hydratedProviders = new Set<ProviderId>()
const hydrationInFlight = new Map<ProviderId, Promise<void>>()
const dirtyProviders = new Set<ProviderId>()
let flushScheduled = false

function createKeyState(provider: ProviderId, key: string): KeyState {
  const internal: KeyInternal = { failures: 0, cooledUntil: 0, hash: hashApiKey(key) }
  const ks = { key } as KeyState
  keyInternals.set(ks, internal)
  const define = (prop: 'failures' | 'cooledUntil') => {
    Object.defineProperty(ks, prop, {
      enumerable: true,
      get: () => internal[prop],
      set: (v: number) => {
        if (internal[prop] === v) return
        internal[prop] = v
        schedulePersist(provider)
      },
    })
  }
  define('failures')
  define('cooledUntil')
  return ks
}

function setKeyStateRaw(ks: KeyState, failures: number, cooledUntil: number): void {
  const internal = keyInternals.get(ks)
  if (internal) {
    internal.failures = failures
    internal.cooledUntil = cooledUntil
  } else {
    ks.failures = failures
    ks.cooledUntil = cooledUntil
  }
}

function keyHashOf(ks: KeyState): string {
  return keyInternals.get(ks)?.hash ?? hashApiKey(ks.key)
}

function bindStore(env: Env, provider: ProviderId): BoundStore {
  const kv = env?.KV
  if (!kv) {
    if (!boundStores.has(provider)) boundStores.set(provider, null)
    return boundStores.get(provider) ?? null
  }
  const existing = boundStores.get(provider)
  if (existing && existing.__kv === kv) return existing
  const store = new KvKeyPoolStore(kv) as KvKeyPoolStore & { __kv?: unknown }
  store.__kv = kv
  boundStores.set(provider, store)
  return store
}

function schedulePersist(provider: ProviderId): void {
  if (!boundStores.get(provider)) return
  dirtyProviders.add(provider)
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    void flushKeyPoolPersistence()
  })
}

export async function flushKeyPoolPersistence(provider?: ProviderId): Promise<void> {
  const targets = provider ? [provider] : [...dirtyProviders]
  for (const p of targets) {
    if (!dirtyProviders.has(p)) continue
    const store = boundStores.get(p)
    if (!store) {
      dirtyProviders.delete(p)
      continue
    }
    try {
      const doc = await store.loadDoc(p)
      applyLocalStateToDoc(p, doc)
      await store.saveDoc(p, doc)
      dirtyProviders.delete(p)
    } catch (e) {
      console.warn(`[ai-key-pool] persist failed for ${p} — memory-only until next write`, e)
    }
  }
}

function applyLocalStateToDoc(provider: ProviderId, doc: KeyPoolDoc): void {
  const pool = keyPools.get(provider)
  const now = Date.now()
  if (pool) {
    for (const ks of pool) {
      const hash = keyHashOf(ks)
      if (ks.failures > 0 || ks.cooledUntil > now) {
        doc.keys[hash] = { failures: ks.failures, cooledUntil: ks.cooledUntil }
      } else {
        delete doc.keys[hash]
      }
    }
  }
  for (const [model, hashes] of revokedHashesByModel) {
    const merged = new Set(doc.revoked[model] ?? [])
    for (const h of hashes) merged.add(h)
    doc.revoked[model] = [...merged]
  }
}

export async function hydrateKeyPool(env: Env, provider: ProviderId): Promise<void> {
  const store = bindStore(env, provider)
  if (!store) {
    hydratedProviders.add(provider)
    return
  }
  const inFlight = hydrationInFlight.get(provider)
  if (inFlight) return inFlight
  const task = (async () => {
    try {
      const doc = await store.loadDoc(provider)
      const pool = keyPools.get(provider)
      if (pool) {
        for (const ks of pool) {
          const entry = doc.keys[keyHashOf(ks)]
          if (entry) {
            setKeyStateRaw(
              ks,
              Math.max(ks.failures, entry.failures || 0),
              Math.max(ks.cooledUntil, entry.cooledUntil || 0),
            )
          }
        }
      }
      for (const [model, hashes] of Object.entries(doc.revoked)) {
        let set = revokedHashesByModel.get(model)
        if (!set) {
          set = new Set()
          revokedHashesByModel.set(model, set)
        }
        for (const h of hashes) set.add(h)
      }
      hydratedProviders.add(provider)
    } catch (e) {
      console.warn(`[ai-key-pool] hydrate failed for ${provider} — starting from memory defaults`, e)
    } finally {
      hydrationInFlight.delete(provider)
    }
  })()
  hydrationInFlight.set(provider, task)
  return task
}

export function getPool(env: Env, provider: ProviderId): KeyState[] {
  let pool = keyPools.get(provider)
  if (!pool) {
    pool = []
    if (provider === 'gemini') {
      for (let i = 1; i <= 4; i++) {
        const k = (env as any)[`GEMINI_API_KEY_${i}`] as string | undefined
        if (k) pool.push(createKeyState(provider, k))
      }
    } else if (provider === 'groq') {
      for (let i = 1; i <= 4; i++) {
        const k = (env as any)[`GROQ_API_KEY_${i}`] as string | undefined
        if (k) pool.push(createKeyState(provider, k))
      }
    } else if (provider === 'nvidia') {
      for (let i = 1; i <= 4; i++) {
        const k = (env as any)[`NVIDIA_API_KEY_${i}`] as string | undefined
        if (k) pool.push(createKeyState(provider, k))
      }
    }
    keyPools.set(provider, pool)
    poolProviders.set(pool, provider)
  }
  bindStore(env, provider)
  if (!hydratedProviders.has(provider) && boundStores.get(provider)) {
    void hydrateKeyPool(env, provider)
  }
  return pool
}

// ---------------------------------------------------------------------------
// 모델별 키 자격 (2026-10-13 실측)
// - gemini-2.5-flash: 키1(index 0)만 "no longer available to new users" 제한 통과
// - 404 INELIGIBLE 발생 시 해당 (모델, 키) 조합을 여기서 제외 → 같은 실패 반복 방지
// - 인스턴스 메모리 기준 (콜드스타트 시 초기값으로 리셋, D1 기록은 ai_error_log로 유지)
// ---------------------------------------------------------------------------
const MODEL_KEY_ALLOWLIST = new Map<string, Set<number>>([
  ['gemini-2.5-flash', new Set([0])],
])

const revokedHashesByModel = new Map<string, Set<string>>()

export function pickKeyForModel(pool: KeyState[], modelId: string): KeyState | null {
  const allow = MODEL_KEY_ALLOWLIST.get(modelId)
  const revoked = revokedHashesByModel.get(modelId)
  const scoped = pool.filter((ks, i) => {
    if (allow && !allow.has(i)) return false
    if (revoked && revoked.has(keyHashOf(ks))) return false
    return true
  })
  return pickKey(scoped)
}

/** 404 접근 제한 시 해당 (모델, 키) 조합을 자격 목록에서 제거 */
export function revokeKeyForModel(pool: KeyState[], modelId: string, ks: KeyState): void {
  const idx = pool.indexOf(ks)
  if (idx < 0) return
  let allow = MODEL_KEY_ALLOWLIST.get(modelId)
  if (!allow) {
    allow = new Set(pool.map((_, i) => i))
    MODEL_KEY_ALLOWLIST.set(modelId, allow)
  }
  allow.delete(idx)
  let revoked = revokedHashesByModel.get(modelId)
  if (!revoked) {
    revoked = new Set()
    revokedHashesByModel.set(modelId, revoked)
  }
  revoked.add(keyHashOf(ks))
  const provider = poolProviders.get(pool)
  if (provider) schedulePersist(provider)
}

export function pickKey(pool: KeyState[]): KeyState | null {
  const now = Date.now()
  const available = pool.filter((k) => k.cooledUntil <= now)
  if (available.length === 0) return null
  // 실패 횟수가 적은 키 우선 → 랜덤 (단순 로드밸런싱)
  // 429가 아닌 실패는 키 탓이 아닐 수 있어 백오프 안 함
  const minFailures = Math.min(...available.map((k) => k.failures))
  const tier = available.filter((k) => k.failures === minFailures)
  return tier[Math.floor(Math.random() * tier.length)]
}
