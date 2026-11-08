import type { PrivacySpan } from './privacy-engine';

const SEPARATED_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]*|AIza[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9_]*|gsk_[A-Za-z0-9]*|nvapi-[A-Za-z0-9_-]*|AKIA[0-9A-Z]*|xox[bap]-[A-Za-z0-9-]*)(?:[ .][A-Za-z0-9_-]{2,})+\b/g;
const API_KEY_FULL_RE = /^(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}|nvapi-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,})$/;

export function scanSeparatedApiKeys(text: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  SEPARATED_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEPARATED_KEY_RE.exec(text)) !== null) {
    const joined = m[0].replace(/[ .]/g, '');
    if (!API_KEY_FULL_RE.test(joined)) continue;
    out.push({ type: 'API_KEY', level: 3, start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}
