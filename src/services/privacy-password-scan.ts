import type { PrivacySpan } from './privacy-engine';

const PW_STOP_WORDS = new Set([
  '입니다',
  '이에요',
  '예요',
  '뭐야',
  '뭔가요',
  '변경',
  '확인',
  '입력',
  '설정',
  '안전하게',
  '안전히',
  '철저하게',
  '철저히',
  '소중하게',
  '소중히',
  '주기적으로',
  '정기적으로',
  '관리하세요',
  '보관하세요',
  '변경하세요',
  '설정하세요',
  '입력하세요',
  '확인하세요',
  '사용하세요',
  '저장하세요',
]);
const PW_GUIDANCE_NOUN_RE = /^(안전|보안|관리|보호|변경|설정|입력|확인|재설정|정책|절차|방법|안내|문의|관련|주의|경고)/;
const PW_GUIDANCE_VERB_RE = /^\s*(관리|보관|보호|변경|설정|입력|확인|사용|저장|공유|노출|유출|삭제|갱신)/;
// 표 스캔의 라벨 접미사(확인·번호 등)와 구어 라벨(비번·pw)까지가 값
// 경계다 — 엔진 본 규칙과 같은 키워드 계열을 유지한다.
const PW_KEYWORD_RE =
  /(?:비밀번호|패스워드|비번|password|passwd|pwd|pw)(?:\s*(?:재확인|확인|입력|란|필드|번호|값|confirm|check|field))?["']?\s*(?:은|는|:|=|is)?\s*/gi;

export function passwordValueOk(v: string, ctx: string): boolean {
  const value = v.trim();
  if (PW_STOP_WORDS.has(value)) return false;
  if (/^[가-힣]+$/.test(value)) {
    if (/(하게|히|적으로|처럼|만큼)$/.test(value)) return false;
    if (PW_GUIDANCE_NOUN_RE.test(value)) return false;
    const after = ctx.slice(ctx.lastIndexOf(value) + value.length);
    if (PW_GUIDANCE_VERB_RE.test(after)) return false;
  }
  return true;
}

export function scanSpacedPassword(text: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  PW_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PW_KEYWORD_RE.exec(text)) !== null) {
    const pos = m.index + m[0].length;
    const tokRe = /[^\s]+/g;
    tokRe.lastIndex = pos;
    const accepted: Array<{ start: number; end: number; core: string }> = [];
    let prevEnd = pos;
    let t: RegExpExecArray | null;
    while ((t = tokRe.exec(text)) !== null && accepted.length < 32) {
      if (!/^\s*$/.test(text.slice(prevEnd, t.index))) break;
      const raw = t[0];
      if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(raw)) break;
      if (/['"`]/.test(raw)) break;
      const core = raw.replace(/[.!?,;:]+$/, '');
      if (!core) break;
      accepted.push({ start: t.index, end: t.index + core.length, core });
      prevEnd = t.index + raw.length;
    }
    if (accepted.length < 2) continue;
    const hasDigitOrSymbol = accepted.some((a) => /\d/.test(a.core) || /[^A-Za-z0-9]/.test(a.core));
    if (!hasDigitOrSymbol) continue;
    const start = accepted[0].start;
    const end = accepted[accepted.length - 1].end;
    if (end - start < 4) continue;
    out.push({ type: 'PASSWORD', level: 3, start, end, value: text.slice(start, end) });
  }
  return out;
}
