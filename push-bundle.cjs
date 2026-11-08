"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/push.ts
var push_exports = {};
__export(push_exports, {
  _resetVapidCache: () => _resetVapidCache,
  createVapidHeader: () => createVapidHeader,
  encryptPayload: () => encryptPayload,
  getVapidPublicKey: () => getVapidPublicKey,
  isPushConfigured: () => isPushConfigured,
  sendPushNotification: () => sendPushNotification
});
module.exports = __toCommonJS(push_exports);
function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - b64.length % 4) % 4;
  const bin = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
var vapidCache = null;
function _resetVapidCache() {
  vapidCache = null;
}
async function getVapidKeys(env) {
  if (vapidCache) return vapidCache;
  const jwkStr = env.VAPID_PRIVATE_KEY;
  if (!jwkStr) throw new Error("vapid_not_configured");
  let jwk;
  try {
    jwk = JSON.parse(jwkStr);
  } catch {
    throw new Error("vapid_key_invalid");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error("vapid_key_invalid");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const pubBytes = concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
  if (pubBytes.length !== 65) throw new Error("vapid_key_invalid");
  vapidCache = { privateKey, publicUncompressedB64: b64urlEncode(pubBytes) };
  return vapidCache;
}
async function getVapidPublicKey(env) {
  return (await getVapidKeys(env)).publicUncompressedB64;
}
function rawToDer(raw) {
  if (raw.length !== 64) throw new Error("bad_signature");
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const encodeInt = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let body = v.slice(i);
    if (body[0] & 128) body = concat(new Uint8Array([0]), body);
    return concat(new Uint8Array([2, body.length]), body);
  };
  const ri = encodeInt(r);
  const si = encodeInt(s);
  const seq = concat(ri, si);
  return concat(new Uint8Array([48, seq.length]), seq);
}
async function createVapidHeader(endpoint, env) {
  const { privateKey, publicUncompressedB64 } = await getVapidKeys(env);
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1e3) + 12 * 3600;
  const sub = env.VAPID_SUBJECT || "mailto:admin@localhost";
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ aud, exp, sub })));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
  const jwt = `${header}.${payload}.${b64urlEncode(rawToDer(rawSig))}`;
  return `vapid t=${jwt}, k=${publicUncompressedB64}`;
}
var RECORD_SIZE = 4096;
async function hmacSha256(keyBytes, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function encryptPayload(sub, payload, opts) {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("subscription_invalid");
  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let ephPrivate;
  let asPublic;
  if (opts?.ephPrivateKey && opts?.asPublic) {
    ephPrivate = opts.ephPrivateKey;
    asPublic = opts.asPublic;
  } else {
    const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    ephPrivate = eph.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  }
  if (asPublic.length !== 65 || asPublic[0] !== 4) throw new Error("bad_ephemeral_key");
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephPrivate, 256)
  );
  const te = new TextEncoder();
  const one = new Uint8Array([1]);
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, asPublic, one);
  const ikm = await hmacSha256(prkKey, keyInfo);
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(te.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const msg = te.encode(JSON.stringify(payload));
  const plainLen = RECORD_SIZE - 16;
  const padLen = plainLen - msg.length - 1;
  if (padLen < 0) throw new Error("payload_too_large");
  const plaintext = concat(msg, new Uint8Array([2]), new Uint8Array(padLen));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext)
  );
  const body = concat(salt, u32be(RECORD_SIZE), new Uint8Array([asPublic.length]), asPublic, ct);
  return { body };
}
async function sendPushNotification(env, sub, payload, ttlSeconds = 3600) {
  try {
    const vapid = await createVapidHeader(sub.endpoint, env);
    const { body } = await encryptPayload(sub, payload);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "Authorization": vapid,
        "TTL": String(ttlSeconds)
      },
      body
    });
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, gone: false, error: (await res.text().catch(() => "")).slice(0, 120) };
    }
    return { ok: true, status: res.status, gone: false };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e?.message || e).slice(0, 120) };
  }
}
function isPushConfigured(env) {
  return !!env.VAPID_PRIVATE_KEY;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  _resetVapidCache,
  createVapidHeader,
  encryptPayload,
  getVapidPublicKey,
  isPushConfigured,
  sendPushNotification
});
