/**
 * Worker 통합 테스트 자동화
 * 로컬 Worker + D1 + 인증 테스트
 */

const SECRET = "qa-local-test-secret-20261012-do-not-use-in-prod";
const WORKER_URL = "http://localhost:18787";

async function createSession(email, secret) {
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ email, exp });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(payload) + '.' + sigB64;
}

async function test() {
  const token = await createSession("qa-test@example.com", SECRET);
  const headers = { "Cookie": `myhub_session=${token}` };

  const tests = [
    { name: "미인증 차단", url: "/api/search?q=test", headers: {}, expect: 401 },
    { name: "인증된 검색", url: "/api/search?q=QA4B_PUBLIC", headers, expect: 200 },
    { name: "잠긴 메모 제외", url: "/api/search?q=QA4B_LOCKED", headers, expectCount: 0 },
    { name: "변조된 쿠키", url: "/api/search?q=test", headers: { "Cookie": "myhub_session=invalid" }, expect: 401 },
  ];

  let passed = 0;
  for (const t of tests) {
    try {
      const res = await fetch(WORKER_URL + t.url, { headers: t.headers });
      const ok = t.expect ? res.status === t.expect : true;
      if (t.expectCount !== undefined) {
        const data = await res.json();
        const countOk = data.count === t.expectCount;
        console.log(`${countOk ? '✓' : '✗'} ${t.name}: ${data.count}건`);
        if (countOk) passed++;
      } else {
        console.log(`${ok ? '✓' : '✗'} ${t.name}: HTTP ${res.status}`);
        if (ok) passed++;
      }
    } catch (e) {
      console.log(`✗ ${t.name}: ${e.message}`);
    }
  }

  console.log(`\n${passed}/${tests.length} 통과`);
  process.exit(passed === tests.length ? 0 : 1);
}

test();
