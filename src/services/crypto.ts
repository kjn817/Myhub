/**
 * 메모 암호화 서비스 (AES-GCM)
 * Worker secret MEMO_ENCRYPTION_KEY 사용
 *
 * 포맷 (키 로테이션 트랙 4, 2026-10-31):
 * - 텍스트 v1(레거시): 'ENC:' + base64(iv12 + ct). 기존 전 암호문이 이 형식.
 * - 텍스트 v2: 'ENC2:' + base64(iv12 + ct). 키 로테이션 도구가 새 키로
 *   재암호화할 때만 쓰는 형식 — 마커가 "어느 세대의 키로 암호화됐는가"를
 *   복호화 경로와 감사 도구가 판별할 수 있게 한다.
 * - 바이트 v1(레거시): iv12 + ct (raw). 잠긴 첨부 Cloudinary 객체의 현행 형식.
 * - 바이트 v2: 'MYH2' 매직 4바이트 + iv12 + ct. 로테이션이 만드는 형식.
 *
 * 복호화는 형식을 가리지 않고 현행 키를 먼저 시도하고, 실패하면 선택적
 * 구 키(MEMO_ENCRYPTION_KEY_PREV 시크릿)가 설정된 경우에 한해 그 키로
 * 재시도한다. 이 폴백이 "로테이션 완료 후 시크릿 교체 전/후"의 혼합
 * 상태(일부 항목은 구 키, 일부는 신 키)를 읽을 수 있게 하는 장치다.
 * 암호화(쓰기)는 항상 현행 키 + 호출자가 고른 형식으로만 한다.
 */

async function importKeyMaterial(keyMaterial: string): Promise<CryptoKey> {
  if (!keyMaterial) {
    throw new Error('MEMO_ENCRYPTION_KEY not configured');
  }
  // 키가 base64인지 hex인지 확인, 아니면 raw string을 해시
  let keyBytes: Uint8Array;
  try {
    // base64 시도
    const bin = atob(keyMaterial);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } catch {
    // raw string을 SHA-256으로 해시해서 32바이트 키 생성
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
    keyBytes = new Uint8Array(hash);
  }
  // 32바이트로 맞추기
  if (keyBytes.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(keyBytes);
    keyBytes = padded;
  } else if (keyBytes.length > 32) {
    keyBytes = keyBytes.slice(0, 32);
  }
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function getKey(env: any): Promise<CryptoKey> {
  return importKeyMaterial(env.MEMO_ENCRYPTION_KEY);
}

/** 구 키(전환 중 폴백용). 미설정이면 null — 폴백을 시도하지 않는다. */
async function getPrevKey(env: any): Promise<CryptoKey | null> {
  const prev = env?.MEMO_ENCRYPTION_KEY_PREV;
  if (!prev || typeof prev !== 'string') return null;
  try {
    return await importKeyMaterial(prev);
  } catch {
    return null;
  }
}

const TEXT_V1_PREFIX = 'ENC:';
const TEXT_V2_PREFIX = 'ENC2:';
const BYTES_V2_MAGIC = new Uint8Array([0x4d, 0x59, 0x48, 0x32]); // 'MYH2'

/** 암호문 텍스트의 세대 판별. 암호문이 아니면 null. */
export function ciphertextFormat(text: unknown): 'v1' | 'v2' | null {
  if (typeof text !== 'string') return null;
  if (text.startsWith(TEXT_V2_PREFIX)) return 'v2';
  if (text.startsWith(TEXT_V1_PREFIX)) return 'v1';
  return null;
}

export function isEncrypted(text: string): boolean {
  return ciphertextFormat(text) !== null;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encryptTextWithCryptoKey(key: CryptoKey, plaintext: string, prefix: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return prefix + bytesToB64(combined);
}

async function decryptTextWithCryptoKey(key: CryptoKey, ciphertext: string): Promise<string> {
  const fmt = ciphertextFormat(ciphertext);
  if (!fmt) return ciphertext; // 암호화되지 않은 경우 그대로 반환 (레거시 동작)
  const b64 = ciphertext.slice(fmt === 'v2' ? TEXT_V2_PREFIX.length : TEXT_V1_PREFIX.length);
  const combined = b64ToBytes(b64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export async function encryptContent(env: any, plaintext: string): Promise<string> {
  const key = await getKey(env);
  return encryptTextWithCryptoKey(key, plaintext, TEXT_V1_PREFIX);
}

export async function decryptContent(env: any, ciphertext: string): Promise<string> {
  if (!isEncrypted(ciphertext)) {
    return ciphertext; // 암호화되지 않은 경우 그대로 반환
  }
  const key = await getKey(env);
  try {
    return await decryptTextWithCryptoKey(key, ciphertext);
  } catch (e) {
    // 전환 중 혼합 상태: 구 키가 설정돼 있으면 그 키로 한 번 더 시도한다.
    const prev = await getPrevKey(env);
    if (prev) return decryptTextWithCryptoKey(prev, ciphertext);
    throw e;
  }
}

// ---------------- 키 지정 프리미티브 (로테이션 도구 전용) ----------------
// 로테이션은 환경 키가 아닌 "요청으로 받은 새 키"로 재암호화해야 하므로
// 키 소재를 직접 받는 프리미티브가 필요하다. 이 함수들은 키 값을
// 반환·저장하지 않으며, 호출자(로테이션 서비스)가 키 수명을 요청 범위
// 안으로 한정한다.

/** 지정 키로 암호화 — 로테이션 산출물이라 v2 마커를 단다. */
export async function encryptContentWithKey(keyMaterial: string, plaintext: string): Promise<string> {
  const key = await importKeyMaterial(keyMaterial);
  return encryptTextWithCryptoKey(key, plaintext, TEXT_V2_PREFIX);
}

/** 지정 키 하나로만 복호화 (v1/v2 모두). 로테이션의 세대 판별(시도 복호화)용. */
export async function decryptContentWithKey(keyMaterial: string, ciphertext: string): Promise<string> {
  const key = await importKeyMaterial(keyMaterial);
  return decryptTextWithCryptoKey(key, ciphertext);
}

/** 지정 키로 바이트 암호화 — v2 매직을 단다. */
export async function encryptBytesWithKey(keyMaterial: string, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await importKeyMaterial(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const result = new Uint8Array(BYTES_V2_MAGIC.length + iv.length + encrypted.byteLength);
  result.set(BYTES_V2_MAGIC, 0);
  result.set(iv, BYTES_V2_MAGIC.length);
  result.set(new Uint8Array(encrypted), BYTES_V2_MAGIC.length + iv.length);
  return result.buffer;
}

/** 지정 키 하나로만 바이트 복호화 (v1/v2 모두). */
export async function decryptBytesWithKey(keyMaterial: string, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await importKeyMaterial(keyMaterial);
  return decryptBytesWithCryptoKey(key, data);
}

function hasV2Magic(combined: Uint8Array): boolean {
  if (combined.length < BYTES_V2_MAGIC.length) return false;
  for (let i = 0; i < BYTES_V2_MAGIC.length; i++) {
    if (combined[i] !== BYTES_V2_MAGIC[i]) return false;
  }
  return true;
}

async function decryptBytesWithCryptoKey(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const combined = new Uint8Array(data);
  const offset = hasV2Magic(combined) ? BYTES_V2_MAGIC.length : 0;
  const iv = combined.slice(offset, offset + 12);
  const encrypted = combined.slice(offset + 12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
}

export async function encryptBytes(env: any, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  // iv(12) + encrypted를 합쳐서 반환 (v1 형식 유지 — 신규 잠금이 만드는 형식)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

export async function decryptBytes(env: any, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await getKey(env);
  try {
    return await decryptBytesWithCryptoKey(key, data);
  } catch (e) {
    const prev = await getPrevKey(env);
    if (prev) return decryptBytesWithCryptoKey(prev, data);
    throw e;
  }
}
