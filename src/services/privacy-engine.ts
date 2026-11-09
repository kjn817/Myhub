import { maskSecrets } from './secret-mask';
import { detectKorean } from './privacy-korean';
import { scanTablePasswords } from './privacy-table-scan';
import { passwordValueOk, scanSpacedPassword } from './privacy-password-scan';
import { scanSeparatedApiKeys } from './privacy-detection-split';

const LEGACY_SENSITIVITY_LEVEL_FLOOR: Record<string, number> = {
  general: 0,
  personal: 1,
  restricted: 2,
};

export class PrivacyEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyEngineError';
  }
}

export interface PrivacySpan {
  type: string;
  level: number;
  start: number;
  end: number;
  value: string;
}

export interface PrivacyFinding {
  type: string;
  level: number;
  start: number;
  end: number;
  source?: string;
  score?: number;
}

export interface CrossMessageSpan {
  messageIndex: number;
  start: number;
  end: number;
  type: string;
  level: number;
}

export interface ClassifyLevelInput {
  text: string;
  policySensitivity?: string;
  memoDerived?: boolean;
  koreanDetect?: boolean;
}

export interface ClassifyLevelResult {
  level: number;
  findings: PrivacyFinding[];
}

interface PrivacyRule {
  type: string;
  level: number;
  re: RegExp;
  group?: number;
  validate?: (value: string, ctx: string) => boolean;
}

const CTX = {
  rrn: /(주민등록|주민번호|주민|생년월일)/,
  biz: /(사업자등록|사업자번호|사업자)/,
  driver: /(운전면허|면허번호|면허증)/,
  passport: /(여권|passport)/i,
  acct: /(계좌|입금|송금|출금|은행|뱅크|bank|account)/i,
};

function rrnChecksumOk(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * w[i];
  const seventh = Number(digits[6]);
  if (seventh >= 5 && seventh <= 8) sum += 2;
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

function bizNoChecksumOk(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const p = Number(digits[i]) * w[i];
    sum += i === 8 ? p + Math.floor(p / 10) : p;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[9]);
}

function luhnOk(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function rrnBirthOk(digits: string): boolean {
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// 비밀번호 라벨 계열 — 표 스캔의 라벨 접미사(확인·번호 등)와 구어
// 라벨(비번)까지가 값 경계다. 따옴표로 감싼 값은 별도 규칙으로 받는다:
// 따옴표를 값 문자에서 제외한 본 규칙만으로는 JSON·인용 형태의 값이
// 통째로 빗나간다.
// JSON에서는 키워드 자체가 따옴표로 감싸이므로("password": …) 접미사
// 뒤의 닫는 따옴표 하나를 라벨 경계로 허용한다.
const PW_LABEL_SRC =
  "(?:비밀번호|패스워드|비번|password|passwd|pwd|pw)(?:\\s*(?:재확인|확인|입력|란|필드|번호|값|confirm|check|field))?[\"']?\\s*(?:은|는|:|=|is)?\\s*";

const RULES: PrivacyRule[] = [
  // 비밀번호 문맥 (값 자체가 비밀 — L3). "비밀번호는 X입니다 / password: X / 비밀번호 X"
  {
    type: 'PASSWORD',
    level: 3,
    re: new RegExp(`${PW_LABEL_SRC}([^\\s,;'"\`]{4,})`, 'gi'),
    group: 1,
    validate: passwordValueOk,
  },
  {
    type: 'PASSWORD',
    level: 3,
    re: new RegExp(`${PW_LABEL_SRC}"([^"\\n]{4,})"`, 'gi'),
    group: 1,
    validate: passwordValueOk,
  },
  {
    type: 'PASSWORD',
    level: 3,
    re: new RegExp(`${PW_LABEL_SRC}'([^'\\n]{4,})'`, 'gi'),
    group: 1,
    validate: passwordValueOk,
  },
  {
    type: 'PASSWORD',
    level: 3,
    re: new RegExp(`${PW_LABEL_SRC}\`([^\`\\n]{4,})\``, 'gi'),
    group: 1,
    validate: passwordValueOk,
  },
  // API 키·토큰 (L3) — secret-mask 패턴 확장
  { type: 'API_KEY', level: 3, re: /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}|nvapi-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,})\b/g },
  { type: 'TOKEN', level: 3, re: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}={0,2})/g, group: 1 },
  { type: 'TOKEN', level: 3, re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'API_KEY', level: 3, re: /(?:api[_-]?key|secret|token|access[_-]?key)["']?\s*[:=]\s*([^\s,;'"`]{8,})/gi, group: 1 },
  // 따옴표로 감싼 일반 비밀값 (JSON·딕셔너리 형태) — 위와 같은 이유.
  { type: 'API_KEY', level: 3, re: /(?:api[_-]?key|secret|token|access[_-]?key)["']?\s*[:=]\s*"([^"\n]{8,})"/gi, group: 1 },
  { type: 'API_KEY', level: 3, re: /(?:api[_-]?key|secret|token|access[_-]?key)["']?\s*[:=]\s*'([^'\n]{8,})'/gi, group: 1 },
  { type: 'TOKEN', level: 3, re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  // 카드 (Luhn 검증 — L2 금융)
  { type: 'CARD', level: 2, re: /\b(?:\d[ -]?){13,19}\b/g, validate: (v) => luhnOk(v) && !/^\d{6}-\d{7}$/.test(v.trim()) },
  // 주민등록번호 (YYMMDD-XXXXXXX, 체크섬 필수 — L2)
  // 주민·사업자 번호는 체크섬 엄격 적용 (Presidio KR과 동일 — 문맥어만으로는
  // 통과시키지 않는다. 체크섬이 틀린 숫자는 실존 번호가 아니므로 오탐 방지)
  { type: 'RRN', level: 2, re: /\b\d{6}-[1-4]\d{6}\b/g, validate: (v) => rrnChecksumOk(v.replace(/\D/g, '')) },
  { type: 'FOREIGNER_NO', level: 2, re: /\b\d{6}-[5-8]\d{6}\b/g, validate: (v) => rrnChecksumOk(v.replace(/\D/g, '')) },
  // 주민등록번호 무하이픈 13자리 (R-03): 체크섬 + 생년월일 자리 검증이
  // 둘 다 통과할 때만 탐지한다 — 일반 13자리 숫자(주문번호 등)의 오탐을
  // 체크섬(1/10)과 날짜 범위 필터로 함께 눌러 결정적으로 판정한다.
  { type: 'RRN', level: 2, re: /\b\d{13}\b/g, validate: (v) => {
    const s = Number(v[6]);
    return s >= 1 && s <= 4 && rrnBirthOk(v) && rrnChecksumOk(v);
  } },
  { type: 'FOREIGNER_NO', level: 2, re: /\b\d{13}\b/g, validate: (v) => {
    const s = Number(v[6]);
    return s >= 5 && s <= 8 && rrnBirthOk(v) && rrnChecksumOk(v);
  } },
  // 사업자등록번호 (XXX-XX-XXXXX, 체크섬 — L2)
  { type: 'BIZ_NO', level: 2, re: /\b\d{3}-\d{2}-\d{5}\b/g, validate: (v) => bizNoChecksumOk(v.replace(/\D/g, '')) },
  // 운전면허 (지역 2자리-YY-XXXXXX-XX 형식 또는 문맥 동반 12자리 — L2)
  { type: 'DRIVER_LICENSE', level: 2, re: /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)-\d{2}-\d{6}-\d{2}\b/g },
  { type: 'DRIVER_LICENSE', level: 2, re: /\b\d{2}-\d{2}-\d{6}-\d{2}\b/g, validate: (_v, ctx) => CTX.driver.test(ctx) },
  // 여권 (문맥 동반 시에만 — 영문1+숫자8 단독은 오탐이 많아 문맥 필수)
  { type: 'PASSPORT', level: 2, re: /\b[A-Z]\d{8}\b/g, validate: (_v, ctx) => CTX.passport.test(ctx) },
  // 한국 휴대전화 (L2 연락처)
  { type: 'PHONE_KR', level: 2, re: /\b01[016789]-?\d{3,4}-?\d{4}\b/g },
  // 국가코드 표기 (+82 10-… — 국내 표기의 0이 탈락한다)
  { type: 'PHONE_KR', level: 2, re: /\+82[ -]?1[016789]-?\d{3,4}-?\d{4}\b/g },
  // 이메일 (L2 연락처)
  { type: 'EMAIL', level: 2, re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // 계좌번호 (R-03, L2 금융): 계좌에는 범용 체크섬이 없어 "형식 + 금융
  // 문맥"을 검증으로 쓴다. 하이픈형은 자리수 합 10~16 + 계좌/은행 문맥,
  // 무하이픈형은 '계좌' 명시 문맥이 있을 때만 (전화·주문번호 오탐 방지).
  {
    type: 'BANK_ACCOUNT',
    level: 2,
    re: /\b\d{2,6}(?:-\d{2,6}){1,3}\b/g,
    validate: (v, ctx) => {
      const n = v.replace(/\D/g, '').length;
      return n >= 10 && n <= 16 && CTX.acct.test(ctx);
    },
  },
  {
    type: 'BANK_ACCOUNT',
    level: 2,
    re: /\b\d{10,14}\b/g,
    validate: (v, ctx) => !v.startsWith('01') && /계좌/.test(ctx),
  },
];

// 보이지 않는 형식 문자 — privacy-detection-view의 판정과 같은 집합을
// 쓴다. 좁은 제로폭 목록만으로는 방향표시 문자(U+200E)나 변형 선택자
// (U+FE00 등)를 숫자에 끼워 넣는 우회를 막지 못한다.
const CF_RE = /\p{Cf}/u;

function isInvisibleCp(cp: string): boolean {
  const code = cp.codePointAt(0) ?? 0;
  if (code === 0x180e) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  if (code >= 0xe0100 && code <= 0xe01ef) return true;
  return CF_RE.test(cp);
}
const FRAGMENT_RE = /[A-Za-z0-9]+(?:[.\/_-][A-Za-z0-9]+)*/g;

export function detectPii(text: string): PrivacyFinding[] {
  if (typeof text !== 'string') throw new PrivacyEngineError('detectPii: non-string input');
  return scan(text).map(({ type, level, start, end }) => ({ type, level, start, end }));
}

function dedupSpans(spans: PrivacySpan[]): PrivacySpan[] {
  const out = [...spans].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PrivacySpan[] = [];
  for (const s of out) {
    if (kept.some((k) => s.start < k.end && s.end > k.start)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function scanRules(text: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (!value) continue;
      // 그룹은 항상 매치의 값 부분(뒤쪽)이다 — 값과 같은 문자열이 키워드
      // 쪽에도 있으면(예: "password: password") 앞에서 찾으면 구간이
      // 키워드로 어긋나 실제 값이 마스킹 밖에 남는다.
      const start = g === 0 ? m.index : m.index + m[0].lastIndexOf(value);
      const ctx = text.slice(Math.max(0, m.index - 24), m.index + m[0].length + 8);
      if (rule.validate && !rule.validate(value, ctx)) continue;
      out.push({ type: rule.type, level: rule.level, start, end: start + value.length, value });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  return out;
}

export function scan(text: string): PrivacySpan[] {
  return dedupSpans([...scanRules(text), ...scanNormalized(text), ...scanSeparatedApiKeys(text), ...scanSpacedPassword(text), ...scanTablePasswords(text)]);
}

function normalizeWithMap(text: string): { norm: string; startMap: number[]; endMap: number[] } {
  let norm = '';
  const startMap: number[] = [];
  const endMap: number[] = [];
  let i = 0;
  for (const cp of text) {
    const start = i;
    i += cp.length;
    if (isInvisibleCp(cp)) continue;
    const n = cp.normalize('NFKC');
    for (let k = 0; k < n.length; k++) {
      startMap.push(start);
      endMap.push(start + cp.length);
    }
    norm += n;
  }
  return { norm, startMap, endMap };
}

function isRrnShapedRaw(raw: string): boolean {
  if (!raw) return false;
  const compact = raw.trim().replace(/\s+/g, '');
  return /^\d{6}[-./_]\d{7}$/.test(compact) || /^\d{6}\s+\d{7}$/.test(raw.trim());
}

function classifyDigits(digits: string, raw: string): { type: string; level: number } | null {
  if (digits.length === 13) {
    const seventh = Number(digits[6]);
    if (seventh >= 1 && seventh <= 4 && rrnBirthOk(digits) && rrnChecksumOk(digits)) return { type: 'RRN', level: 2 };
    if (seventh >= 5 && seventh <= 8 && rrnBirthOk(digits) && rrnChecksumOk(digits)) return { type: 'FOREIGNER_NO', level: 2 };
    if (isRrnShapedRaw(raw)) return null;
  }
  if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) return { type: 'CARD', level: 2 };
  if ((digits.length === 10 || digits.length === 11) && /^01[016789]\d{3,4}\d{4}$/.test(digits)) return { type: 'PHONE_KR', level: 2 };
  // 국가코드 82가 붙은 휴대전화 (82+10… = 12자리, 82+010… = 13자리).
  // 13자리에서 주민번호 체크섬이 성립하면 위에서 이미 RRN으로 판정됐다.
  if (digits.length === 12 && digits.startsWith('82') && /^1[016789]\d{3,4}\d{4}$/.test(digits.slice(2))) {
    return { type: 'PHONE_KR', level: 2 };
  }
  if (digits.length === 13 && digits.startsWith('82') && /^01[016789]\d{3,4}\d{4}$/.test(digits.slice(2))) {
    return { type: 'PHONE_KR', level: 2 };
  }
  return null;
}

function scanNormalized(text: string): PrivacySpan[] {
  const { norm, startMap, endMap } = normalizeWithMap(text);
  const changed = norm !== text;
  const map = changed
    ? (s: number, e: number): [number, number] => [startMap[s], endMap[e - 1]]
    : (s: number, e: number): [number, number] => [s, e];
  const toOrig = (sp: PrivacySpan): PrivacySpan => {
    const [start, end] = map(sp.start, sp.end);
    return { type: sp.type, level: sp.level, start, end, value: text.slice(start, end) };
  };
  const out: PrivacySpan[] = [];
  if (changed) for (const sp of scanRules(norm)) out.push(toOrig(sp));
  out.push(...scanCollapsedDigits(norm).map(toOrig));
  out.push(...scanBase64Candidates(norm).map(toOrig));
  return out;
}

function scanCollapsedDigits(norm: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  const re = /(?<![0-9A-Za-z])\d(?:[ \t\r\n.\/_·-]*\d){7,}(?![0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 19) continue;
    const hit = classifyDigits(digits, raw);
    if (hit) {
      out.push({ type: hit.type, level: hit.level, start: m.index, end: m.index + raw.length, value: raw });
      continue;
    }
    if (digits.length === 10 && bizNoChecksumOk(digits)) {
      const ctx = norm.slice(Math.max(0, m.index - 24), m.index + raw.length + 8);
      if (CTX.biz.test(ctx)) {
        out.push({ type: 'BIZ_NO', level: 2, start: m.index, end: m.index + raw.length, value: raw });
        continue;
      }
    }
    if (digits.length >= 10 && digits.length <= 16 && /[\s.\/_·]/.test(raw) && !isRrnShapedRaw(raw)) {
      const ctx = norm.slice(Math.max(0, m.index - 24), m.index + raw.length + 8);
      if (CTX.acct.test(ctx)) out.push({ type: 'BANK_ACCOUNT', level: 2, start: m.index, end: m.index + raw.length, value: raw });
    }
  }
  return out;
}

function scanBase64Candidates(norm: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  const re = /[A-Za-z0-9+/=_-]{16,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const tok = m[0];
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(tok) && !/^[A-Za-z0-9_-]+={0,2}$/.test(tok)) continue;
    if (tok.length % 4 === 1) continue;
    const decoded = tryDecodeBase64(tok);
    if (decoded === null) continue;
    const trimmed = decoded.trim();
    if (/^\d[\d \t.\/_-]*\d$/.test(trimmed)) {
      const hit = classifyDigits(trimmed.replace(/\D/g, ''), trimmed);
      if (hit) {
        out.push({ type: hit.type, level: hit.level, start: m.index, end: m.index + tok.length, value: tok });
        continue;
      }
    }
    // 숫자가 아닌 비밀(API 키 등)이 통째로 인코딩된 경우 — 복호한 내용
    // 전체가 하나의 탐지 구간으로 덮일 때만 인코딩 토큰 전체를 구간으로
    // 삼는다 (메시지 조각 탐지와 같은 판정 기준). 복호 길이는 매 단계
    // 엄격히 줄어들어 재귀가 종료한다.
    if (trimmed.length > 0 && trimmed.length <= 200) {
      const inner = scan(trimmed).find((sp) => sp.level >= 2 && sp.start <= 1 && sp.end >= trimmed.length - 1);
      if (inner) out.push({ type: inner.type, level: inner.level, start: m.index, end: m.index + tok.length, value: tok });
    }
  }
  return out;
}

function tryDecodeBase64(tok: string): string | null {
  try {
    let b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function classifyConcat(concat: string): { type: string; level: number } | null {
  if (!concat || concat.length > 80) return null;
  if (/^[0-9.\/_-]+$/.test(concat)) return classifyDigits(concat.replace(/\D/g, ''), concat);
  const hit = scan(concat).find((sp) => sp.level >= 2 && sp.start <= 1 && sp.end >= concat.length - 1);
  return hit ? { type: hit.type, level: hit.level } : null;
}

export function detectCrossMessageSpans(messages: string[]): CrossMessageSpan[] {
  interface Frag {
    msg: number;
    start: number;
    end: number;
    value: string;
    rankFromStart: number;
    rankFromEnd: number;
  }
  const frags: Frag[] = [];
  messages.forEach((text, mi) => {
    if (typeof text !== 'string') return;
    const local: Frag[] = [];
    FRAGMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FRAGMENT_RE.exec(text)) !== null) {
      local.push({ msg: mi, start: m.index, end: m.index + m[0].length, value: m[0], rankFromStart: local.length, rankFromEnd: 0 });
    }
    local.forEach((f, i) => {
      f.rankFromEnd = local.length - 1 - i;
      frags.push(f);
    });
  });
  const out: CrossMessageSpan[] = [];
  const claimed = new Set<number>();
  for (let s = 0; s < frags.length; s++) {
    if (claimed.has(s) || frags[s].rankFromEnd > 2) continue;
    for (let e = s + 1; e < frags.length && e - s + 1 <= 6; e++) {
      if (frags[e].msg === frags[s].msg) continue;
      if (frags[e].rankFromStart > 2) break;
      const win = frags.slice(s, e + 1);
      const hit = classifyConcat(win.map((f) => f.value).join(''));
      if (hit) {
        win.forEach((f, k) => {
          claimed.add(s + k);
          out.push({ messageIndex: f.msg, start: f.start, end: f.end, type: hit.type, level: hit.level });
        });
        break;
      }
    }
  }
  return out;
}

export function classifyLevel(input: ClassifyLevelInput): ClassifyLevelResult {
  const findings = detectPii(input.text);
  if (input.koreanDetect) {
    const sensitive = input.policySensitivity === 'personal' || input.policySensitivity === 'restricted' || !!input.memoDerived;
    for (const kf of detectKorean(input.text, { sensitiveSource: sensitive })) {
      if (findings.some((f) => kf.start < f.end && kf.end > f.start)) continue;
      findings.push({ type: kf.type, level: kf.level, start: kf.start, end: kf.end, source: 'context', score: kf.score });
    }
    findings.sort((a, b) => a.start - b.start);
  }
  let level = 0;
  for (const f of findings) if (f.level > level) level = f.level;
  const floor = Math.max(
    LEGACY_SENSITIVITY_LEVEL_FLOOR[input.policySensitivity ?? ''] ?? 0,
    input.memoDerived ? 1 : 0,
  );
  if (level < floor) level = floor;
  return { level, findings };
}

export function redactForLog(text: unknown, maxLen = 500): string {
  try {
    const vault = new TokenVault();
    const { text: tokenized } = vault.sanitize(String(text ?? ''));
    const masked = maskSecrets(tokenized).masked;
    return masked.replace(/key=[^&\s]+/gi, 'key=[REDACTED]').replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]').slice(0, maxLen);
  } catch {
    return '[REDACTED:engine-error]';
  }
}

export class TokenVault {
  tokenToValue = new Map<string, string>();
  valueToToken = new Map<string, string>();
  counters = new Map<string, number>();

  sanitize(text: string): { text: string; findings: PrivacyFinding[] } {
    return this.sanitizeWith(text, []);
  }

  /**
   * 추가 구간(메시지 결합 검사로 찾은 프래그먼트 등)을 함께 토큰화한다.
   * 추가 구간의 값은 원본 부분 문자열이며, 복원은 프래그먼트 단위로 일어난다.
   */
  sanitizeWith(
    text: string,
    extra: Array<{ type: string; level: number; start: number; end: number }>,
  ): { text: string; findings: PrivacyFinding[] } {
    const spans = dedupSpans([
      ...scan(text),
      ...extra.map((x) => ({ ...x, value: text.slice(x.start, x.end) })),
    ]);
    let out = text;
    for (const s of [...spans].sort((a, b) => b.start - a.start)) {
      const key = `${s.type}:${s.value}`;
      let token = this.valueToToken.get(key);
      if (!token) {
        const n = (this.counters.get(s.type) ?? 0) + 1;
        this.counters.set(s.type, n);
        token = `[${s.type}_${n}]`;
        this.valueToToken.set(key, token);
        this.tokenToValue.set(token, s.value);
      }
      out = out.slice(0, s.start) + token + out.slice(s.end);
    }
    return { text: out, findings: spans.map(({ type, level, start, end }) => ({ type, level, start, end })) };
  }

  /** 사용자 표시용 최종 텍스트에만 복원한다. */
  desanitize(text: string): string {
    let out = text;
    for (const [token, value] of this.tokenToValue) {
      out = out.split(token).join(value);
    }
    return out;
  }

  get size(): number {
    return this.tokenToValue.size;
  }
}
