/**
 * 메모 암호화 서비스 (AES-GCM)
 * Worker secret MEMO_ENCRYPTION_KEY 사용
 */

async function getKey(env: any): Promise<CryptoKey> {
  const keyMaterial = env.MEMO_ENCRYPTION_KEY;
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

export async function encryptContent(env: any, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  // iv + encrypted를 base64로 인코딩
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  let bin = '';
  for (let i = 0; i < combined.length; i++) bin += String.fromCharCode(combined[i]);
  return 'ENC:' + btoa(bin);
}

export async function decryptContent(env: any, ciphertext: string): Promise<string> {
  if (!ciphertext.startsWith('ENC:')) {
    return ciphertext; // 암호화되지 않은 경우 그대로 반환
  }
  const key = await getKey(env);
  const b64 = ciphertext.slice(4);
  const bin = atob(b64);
  const combined = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) combined[i] = bin.charCodeAt(i);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export function isEncrypted(text: string): boolean {
  return typeof text === 'string' && text.startsWith('ENC:');
}

export async function encryptBytes(env: any, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  // iv(12) + encrypted를 합쳐서 반환
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

export async function decryptBytes(env: any, data: ArrayBuffer): Promise<ArrayBuffer> {
  const combined = new Uint8Array(data);
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const key = await getKey(env);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
}


