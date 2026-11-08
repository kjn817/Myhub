import { detectPii } from './privacy-engine';
import { maskSecrets } from './secret-mask';

const PLACEHOLDER_BY_TYPE: Record<string, string> = {
  CARD: '[CARD_MASKED]',
  RRN: '[RRN_MASKED]',
  FOREIGNER_NO: '[FOREIGNER_NO_MASKED]',
  BIZ_NO: '[BIZ_NO_MASKED]',
  DRIVER_LICENSE: '[DRIVER_LICENSE_MASKED]',
  PASSPORT: '[PASSPORT_MASKED]',
  PHONE_KR: '[PHONE_MASKED]',
  EMAIL: '[EMAIL_MASKED]',
  API_KEY: '[API_KEY_MASKED]',
  TOKEN: '[TOKEN_MASKED]',
  PASSWORD: '[PASSWORD_MASKED]',
  BANK_ACCOUNT: '[BANK_ACCOUNT_MASKED]',
  NAME: '[NAME_MASKED]',
  ADDRESS: '[ADDRESS_MASKED]',
  RELATION: '[RELATION_MASKED]',
};
const ALREADY_MASKED_RE = /\[[A-Z_]+(?:_MASKED|_\d+)\]/g;
const LOCKED_MARKER_RE = /\[(?:LOCKED_BLOCK|LOCKED_MEMO|LOCKED_CONTENT|LOCKED)[^\]]*\]/g;

function overlapsAny(start: number, end: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

export function maskWithPrivacyEngine(text: string): { masked: string; count: number } {
  const legacy = maskSecrets(text || '');
  let masked = legacy.masked;
  let count = legacy.count;
  let findings;
  try {
    findings = detectPii(masked);
  } catch {
    return { masked: '[REDACTED:engine-error]', count: count + 1 };
  }
  if (findings.length === 0) return { masked, count };
  const maskedSpans: Array<{ start: number; end: number }> = [];
  ALREADY_MASKED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ALREADY_MASKED_RE.exec(masked)) !== null) {
    maskedSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  const targets = findings.filter((f) => !overlapsAny(f.start, f.end, maskedSpans)).sort((a, b) => b.start - a.start);
  for (const f of targets) {
    masked = masked.slice(0, f.start) + PLACEHOLDER_BY_TYPE[f.type] + masked.slice(f.end);
    count++;
  }
  return { masked, count };
}

export function maskForExternalEgress(text: string): string {
  const { masked } = maskWithPrivacyEngine(text || '');
  return masked.replace(LOCKED_MARKER_RE, '(잠긴 내용 제외됨)');
}

export function maskStringsDeep(value: unknown, skipKeys: Set<string> = new Set(['date', 'timezone'])): unknown {
  if (typeof value === 'string') return maskForExternalEgress(value);
  if (Array.isArray(value)) return value.map((v) => maskStringsDeep(v, skipKeys));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && skipKeys.has(k) ? v : maskStringsDeep(v, skipKeys);
    }
    return out;
  }
  return value;
}
