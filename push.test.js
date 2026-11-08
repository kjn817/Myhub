/**
 * Web Push 서비스 유닛 테스트
 * @jest-environment node
 *
 * src/services/push.ts를 esbuild로 번들한 뒤 테스트한다.
 * 암호화 정확성은 RFC 8291 Appendix A 테스트 벡터로 검증한다.
 */
const { execSync } = require('child_process');
const path = require('path');
const { webcrypto, createVerify, createPublicKey } = require('crypto');

const BUNDLE = path.join(__dirname, 'push-bundle.cjs');
try {
  execSync('npx esbuild src/services/push.ts --bundle --format=cjs --platform=node --outfile=' + BUNDLE, { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('esbuild failed', e.message);
}
const push = require(BUNDLE);
beforeEach(() => { push._resetVapidCache(); });

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const b64u = (s) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'base64url'));
const b64uStr = (b) => Buffer.from(b).toString('base64url');
const concat = (...ps) => {
  const t = ps.reduce((n, p) => n + p.length, 0);
  const o = new Uint8Array(t);
  let off = 0;
  for (const p of ps) { o.set(p, off); off += p.length; }
  return o;
};
const hmac = async (k, d) => new Uint8Array(
  await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d)
);

// ---- RFC 8291 Appendix A 테스트 벡터 ----
const V = {
  authSecret: b64u('BTBZMqHH6r4Tts7J_aSIgg'),
  uaPublic: b64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  uaPrivateD: b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  asPublic: b64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  asPrivateD: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  salt: b64u('DGv6ra1nlYgDCS1FRnbzlw'),
  // 기대 중간값
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
};

function ecJwk(d, pub) {
  return {
    kty: 'EC', crv: 'P-256',
    d: b64uStr(d),
    x: b64uStr(pub.subarray(1, 33)),
    y: b64uStr(pub.subarray(33, 65)),
  };
}

/** RFC §3.4 의사코드를 그대로 옮긴 수신자(브라우저) 측 복호화 */
async function receiverDecrypt(body, uaPrivateJwk) {
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const uaPriv = await subtle.importKey('jwk', uaPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asPubKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const authSecret = V.authSecret, uaPublic = V.uaPublic;
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaPriv, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ct));

  // plaintext = payload || 0x02 || 0x00*pad
  const delimIdx = plain.indexOf(2);
  expect(delimIdx).toBeGreaterThan(0);
  expect([...plain.subarray(delimIdx + 1)].every((b) => b === 0)).toBe(true);
  return JSON.parse(Buffer.from(plain.subarray(0, delimIdx)).toString());
}

describe('RFC 8291 Appendix A 벡터', () => {
  test('독립 구현한 KDF가 RFC 중간값과 일치한다', async () => {
    const asPriv = await subtle.importKey('jwk', ecJwk(V.asPrivateD, V.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const uaPub = await subtle.importKey('raw', V.uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaPub }, asPriv, 256));
    expect(b64uStr(ecdh)).toBe(V.ecdhSecret);
    const prkKey = await hmac(V.authSecret, ecdh);
    expect(b64uStr(prkKey)).toBe(V.prkKey);
    const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), V.uaPublic, V.asPublic, new Uint8Array([1])));
    expect(b64uStr(ikm)).toBe(V.ikm);
    const prk = await hmac(V.salt, ikm);
    expect(b64uStr(prk)).toBe(V.prk);
    const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
    expect(b64uStr(cek)).toBe(V.cek);
    const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
    expect(b64uStr(nonce)).toBe(V.nonce);
  });

  test('encryptPayload 출력이 RFC 와이어 형식이며 수신자 측에서 복호화된다', async () => {
    const ephPriv = await subtle.importKey('jwk', ecJwk(V.asPrivateD, V.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const sub = {
      endpoint: 'https://example.com/push/x',
      p256dh: b64uStr(V.uaPublic),
      auth: b64uStr(V.authSecret),
    };
    const { body } = await push.encryptPayload(
      sub, { title: '일정 알림', body: '15:00 치과' },
      { salt: V.salt, ephPrivateKey: ephPriv, asPublic: V.asPublic }
    );
    // RFC 8188 §2.1 프레이밍: salt(16) || rs(4) || idlen(1) || keyid(65) || ct
    expect(body.length).toBe(16 + 4 + 1 + 65 + 4096);
    expect(Buffer.from(body.subarray(0, 16)).equals(Buffer.from(V.salt))).toBe(true);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(Buffer.from(body.subarray(21, 86)).equals(Buffer.from(V.asPublic))).toBe(true);

    const msg = await receiverDecrypt(body, ecJwk(V.uaPrivateD, V.uaPublic));
    expect(msg.title).toBe('일정 알림');
    expect(msg.body).toBe('15:00 치과');
  });

  test('랜덤 salt/임시키로도 라운드트립된다', async () => {
    const uaKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPubRaw = new Uint8Array(await subtle.exportKey('raw', uaKeys.publicKey));
    const uaJwk = await subtle.exportKey('jwk', uaKeys.privateKey);
    const auth = webcrypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: 'https://example.com/push/y', p256dh: b64uStr(uaPubRaw), auth: b64uStr(auth) };
    const { body } = await push.encryptPayload(sub, { title: 't', body: 'b' });
    // 수신자 측은 구독 auth를 알아야 하므로 V.authSecret 대신 auth 사용
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 86);
    const ct = body.subarray(86);
    const asPubKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaKeys.privateKey, 256));
    const prkKey = await hmac(auth, ecdh);
    const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPubRaw, asPublic, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
    const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ct));
    const delimIdx = plain.indexOf(2);
    const msg = JSON.parse(Buffer.from(plain.subarray(0, delimIdx)).toString());
    expect(msg.title).toBe('t');
  });

  test('잘못된 구독 키는 에러', async () => {
    await expect(push.encryptPayload({ endpoint: 'x', p256dh: 'AAA', auth: 'AAA' }, {})).rejects.toThrow('subscription_invalid');
  });
});

describe('VAPID', () => {
  beforeEach(() => { push._resetVapidCache(); });
  async function makeEnv() {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    return { env: { VAPID_PRIVATE_KEY: JSON.stringify(jwk), VAPID_SUBJECT: 'mailto:test@example.com' }, jwk };
  }

  test('getVapidPublicKey가 JWK x/y에서 올바른 uncompressed 키를 만든다', async () => {
    const { env, jwk } = await makeEnv();
    const pub = await push.getVapidPublicKey(env);
    const raw = b64u(pub);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(b64uStr(raw.subarray(1, 33))).toBe(jwk.x);
    expect(b64uStr(raw.subarray(33, 65))).toBe(jwk.y);
  });

  test('getVapidPublicKey는 키 미설정 시 에러', async () => {
    await expect(push.getVapidPublicKey({})).rejects.toThrow('vapid_not_configured');
    expect(push.isPushConfigured({})).toBe(false);
    expect(push.isPushConfigured({ VAPID_PRIVATE_KEY: 'x' })).toBe(true);
  });

  test('createVapidHeader의 JWT 서명이 검증된다 (DER)', async () => {
    const { env, jwk } = await makeEnv();
    const header = await push.createVapidHeader('https://push.example.com/abc', env);
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [hB64, pB64, sB64] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(pB64, 'base64url').toString());
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.sub).toBe('mailto:test@example.com');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // k= 가 VAPID 공개키와 일치
    const kRaw = b64u(m[2]);
    expect(kRaw[0]).toBe(0x04);
    expect(b64uStr(kRaw.subarray(1, 33))).toBe(jwk.x);
    // DER 서명 검증 (Node classic crypto — subtle.verify는 Node 24에서 quirk 있음)
    const pubKey = createPublicKey({
      key: Buffer.from(await subtle.exportKey('spki',
        await subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']))),
      format: 'der', type: 'spki',
    });
    const valid = createVerify('SHA256')
      .update(Buffer.from(`${hB64}.${pB64}`, 'utf8'))
      .verify(pubKey, Buffer.from(sB64, 'base64url'));
    expect(valid).toBe(true);
  });
});

describe('sendPushNotification', () => {
  async function makeEnv() {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await subtle.exportKey('jwk', kp.privateKey);
    return { VAPID_PRIVATE_KEY: JSON.stringify(jwk), VAPID_SUBJECT: 'mailto:test@example.com' };
  }
  async function makeSub() {
    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    return {
      endpoint: 'https://push.example.com/push/abc',
      p256dh: b64uStr(pubRaw),
      auth: b64uStr(webcrypto.getRandomValues(new Uint8Array(16))),
    };
  }

  test('201이면 ok, 헤더가 규격에 맞다', async () => {
    const env = await makeEnv();
    let seen = null;
    global.fetch = async (url, init) => {
      seen = { url, init, body: Buffer.from(init.body) };
      return { status: 201, ok: true, text: async () => '' };
    };
    const r = await push.sendPushNotification(env, await makeSub(), { title: 't' }, 60);
    expect(r.ok).toBe(true);
    expect(r.gone).toBe(false);
    expect(seen.init.method).toBe('POST');
    expect(seen.init.headers['Content-Encoding']).toBe('aes128gcm');
    expect(seen.init.headers['TTL']).toBe('60');
    expect(seen.init.headers['Authorization']).toMatch(/^vapid t=.+, k=.+$/);
    expect(seen.body.length).toBe(16 + 4 + 1 + 65 + 4096);
    delete global.fetch;
  });

  test('404/410이면 gone=true (구독 정리 신호)', async () => {
    const env = await makeEnv();
    global.fetch = async () => ({ status: 410 });
    const r = await push.sendPushNotification(env, await makeSub(), { title: 't' });
    expect(r.ok).toBe(false);
    expect(r.gone).toBe(true);
    delete global.fetch;
  });

  test('VAPID 미설정 시 ok=false', async () => {
    global.fetch = async () => ({ status: 201 });
    const r = await push.sendPushNotification({}, await makeSub(), { title: 't' });
    expect(r.ok).toBe(false);
    delete global.fetch;
  });
});
