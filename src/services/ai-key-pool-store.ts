export interface KeyPoolKeyState {
  failures: number
  cooledUntil: number
}

export interface KeyPoolDoc {
  v: 1
  keys: Record<string, KeyPoolKeyState>
  revoked: Record<string, string[]>
}

const SHA256_K = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221,
  3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580,
  3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986,
  2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895,
  666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037,
  2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344,
  430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779,
  1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298,
]

function rotr(x: number, n: number): number {
  return (x >>> n | x << 32 - n) >>> 0
}

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64
  const msg = new Uint8Array(paddedLen)
  msg.set(bytes)
  msg[bytes.length] = 128
  const view = new DataView(msg.buffer)
  view.setUint32(paddedLen - 4, bitLen >>> 0)
  let h0 = 1779033703, h1 = 3144134277, h2 = 1013904242, h3 = 2773480762
  let h4 = 1359893119, h5 = 2600822924, h6 = 528734635, h7 = 1541459225
  const w = new Uint32Array(64)
  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3) >>> 0
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10) >>> 0
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = (e & f ^ ~e & g) >>> 0
      const t1 = h + s1 + ch + SHA256_K[i] + w[i] >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = (a & b ^ a & c ^ b & c) >>> 0
      const t2 = s0 + maj >>> 0
      h = g
      g = f
      f = e
      e = d + t1 >>> 0
      d = c
      c = b
      b = a
      a = t1 + t2 >>> 0
    }
    h0 = h0 + a >>> 0
    h1 = h1 + b >>> 0
    h2 = h2 + c >>> 0
    h3 = h3 + d >>> 0
    h4 = h4 + e >>> 0
    h5 = h5 + f >>> 0
    h6 = h6 + g >>> 0
    h7 = h7 + h >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('')
}

export function hashApiKey(key: string): string {
  return sha256Hex(key).slice(0, 32)
}

export function emptyKeyPoolDoc(): KeyPoolDoc {
  return { v: 1, keys: {}, revoked: {} }
}

export function keyPoolDocKey(provider: string): string {
  return `ai-key-pool:v1:${provider}`
}

export class KvKeyPoolStore {
  constructor(kv: KVNamespace) {
    this.kv = kv
  }

  kv: KVNamespace

  /** 문서가 없거나 깨졌으면 null/빈 문서. KV 장애는 throw — 호출자가 fail-soft 처리한다. */
  async loadDoc(provider: string): Promise<KeyPoolDoc> {
    const raw = await this.kv.get(keyPoolDocKey(provider))
    if (!raw) return emptyKeyPoolDoc()
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return emptyKeyPoolDoc()
      return {
        v: 1,
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        revoked: parsed.revoked && typeof parsed.revoked === 'object' ? parsed.revoked : {},
      }
    } catch {
      console.warn('[ai-key-pool] persisted doc parse failed — treating as empty')
      return emptyKeyPoolDoc()
    }
  }

  async saveDoc(provider: string, doc: KeyPoolDoc): Promise<void> {
    await this.kv.put(keyPoolDocKey(provider), JSON.stringify(doc))
  }
}
