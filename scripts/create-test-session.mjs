/**
 * 테스트용 세션 생성 스크립트
 * 실제 createSession() 로직과 동일한 방식으로 세션 생성
 *
 * 사용법: node scripts/create-test-session.mjs <email> <secret>
 */

async function createSession(email, secret) {
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 1일
  const payload = JSON.stringify({ email, exp });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(payload) + '.' + sigB64;
}

const email = process.argv[2] || 'test@example.com';
const secret = process.argv[3] || 'test-secret-key-for-qa';

const token = await createSession(email, secret);
console.log(token);
