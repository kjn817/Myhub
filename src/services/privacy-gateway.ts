import {
  TokenVault,
  PrivacyEngineError,
  classifyLevel,
  detectCrossMessageSpans,
  type PrivacyFinding,
} from './privacy-engine';
import { extractCandidates, actionFor, judgeKorean, type KoreanAction } from './privacy-korean';
import { classifyWithClef, KoreanClassifierError, type ClefInvoke } from './privacy-korean-clef';

export const PRIVACY_GATEWAY_BLOCK_MESSAGE = '개인정보 보호 게이트웨이가 전송을 차단했습니다.';

export class PrivacyGatewayBlockedError extends Error {
  constructor(reasons: string[]) {
    super(PRIVACY_GATEWAY_BLOCK_MESSAGE);
    this.reasons = reasons;
    this.name = 'PrivacyGatewayBlockedError';
  }

  readonly reasons: string[];
  readonly code = 'PRIVACY_GATEWAY_BLOCKED';
  readonly retryable = false;
}

export interface PrivacyGatewayMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface InspectEgressInput {
  origin: string;
  messages: PrivacyGatewayMessage[];
  policy?: { sensitivity?: string; privacy?: string };
  memoDerived?: boolean;
}

export interface InspectEgressResult {
  action: 'allow' | 'tokenized' | 'block';
  messages: PrivacyGatewayMessage[];
  level: number;
  reasons: string[];
  findings: PrivacyFinding[];
  vault: TokenVault;
}

export interface InspectEgressKoreanInput extends InspectEgressInput {
  mode: 'shadow' | 'enforce';
  clefInvoke?: ClefInvoke;
}

export interface KoreanDecision {
  type: string;
  action: KoreanAction;
  scoreBand: string;
}

export interface InspectEgressKoreanResult extends InspectEgressResult {
  koreanDecisions: KoreanDecision[];
  koreanMode: 'shadow' | 'enforce';
  relationSignal: boolean;
}

const LOCKED_MARKERS = ['[LOCKED_BLOCK', '[LOCKED_MEMO', '[LOCKED_CONTENT', '[LOCKED]'];
const EGRESS_JUDGE_MAX_CANDIDATES = 512;

export function privacyGatewayUserNotice(reasons: string[]): string {
  const set = new Set(reasons);
  if (set.has('locked-source')) {
    return '개인정보 보호 게이트웨이가 이 요청의 외부 AI 전송을 차단했습니다. 잠긴 메모 내용은 보낼 수 없습니다.';
  }
  if (set.has('l3-standalone-secret')) {
    return '개인정보 보호 게이트웨이가 이 요청의 외부 AI 전송을 차단했습니다. 단독 비밀정보(비밀번호 등)는 보낼 수 없습니다.';
  }
  if (set.has('engine-error') || [...set].some((r) => r.startsWith('korean-'))) {
    return '개인정보 검사에서 문제가 생겨 이 요청의 전송을 중단했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return '개인정보 보호 게이트웨이가 이 요청의 외부 AI 전송을 차단했습니다. 민감한 정보가 포함된 요청은 보낼 수 없습니다.';
}

function hasLockedMarker(text: string): boolean {
  return LOCKED_MARKERS.some((m) => text.includes(m));
}

function isStandaloneSecret(text: string, findings: PrivacyFinding[]): boolean {
  const l3 = findings.filter((f) => f.level === 3 && f.type === 'PASSWORD');
  if (l3.length === 0) return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  const covered = l3.reduce((n, f) => n + (f.end - f.start), 0);
  return covered / Math.max(1, trimmed.length) > 0.35;
}

export function inspectEgress(input: InspectEgressInput): InspectEgressResult {
  try {
    const vault = new TokenVault();
    const reasons: string[] = [];
    let level = 0;
    const allFindings: PrivacyFinding[] = [];
    for (const m of input.messages) {
      if (typeof m.content === 'string' && hasLockedMarker(m.content)) {
        reasons.push('locked-source');
        return { action: 'block', messages: input.messages, level: 3, reasons, findings: [], vault };
      }
    }
    const crossSpans = detectCrossMessageSpans(
      input.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
    );
    const crossByMsg = new Map<number, typeof crossSpans>();
    for (const sp of crossSpans) {
      const arr = crossByMsg.get(sp.messageIndex) ?? [];
      arr.push(sp);
      crossByMsg.set(sp.messageIndex, arr);
    }
    const out = input.messages.map((m, mi) => {
      if (typeof m.content !== 'string') throw new PrivacyEngineError('non-string message content');
      if (!m.content) return m;
      const cls = classifyLevel({
        text: m.content,
        policySensitivity: input.policy?.sensitivity,
        memoDerived: input.memoDerived,
      });
      const extra = crossByMsg.get(mi) ?? [];
      const findings: PrivacyFinding[] = [...cls.findings, ...extra.map(({ type, level: lv, start, end }) => ({ type, level: lv, start, end }))];
      const msgLevel = Math.max(cls.level, ...extra.map((x) => x.level), 0);
      if (msgLevel > level) level = msgLevel;
      for (const f of findings) reasons.push(`pii:${f.type}:L${f.level}`);
      allFindings.push(...findings);
      if (msgLevel >= 2) {
        if (isStandaloneSecret(m.content, findings)) {
          reasons.push('l3-standalone-secret');
          return m;
        }
        const { text } = vault.sanitizeWith(m.content, extra);
        return { ...m, content: text };
      }
      return m;
    });
    if (reasons.includes('l3-standalone-secret')) {
      return { action: 'block', messages: input.messages, level, reasons, findings: allFindings, vault };
    }
    const action = level >= 2 ? 'tokenized' : 'allow';
    return { action, messages: out, level, reasons: [...new Set(reasons)], findings: allFindings, vault };
  } catch (e) {
    if (e instanceof PrivacyEngineError) throw new PrivacyGatewayBlockedError(['engine-error']);
    throw new PrivacyGatewayBlockedError(['engine-error']);
  }
}

export function guardSearchQuery(query: string): string | null {
  try {
    const r = inspectEgress({ origin: 'search-query', messages: [{ role: 'user', content: query }] });
    if (r.action === 'block' || r.level >= 2) {
      console.info('search_query_blocked', { reasons: r.reasons.join(',') });
      return null;
    }
    return query;
  } catch {
    console.info('search_query_blocked', { reasons: 'gateway-error' });
    return null;
  }
}

export function scoreBand(score: number): string {
  if (score >= 0.85) return 'ge-0.85';
  if (score >= 0.75) return '0.75-0.85';
  if (score >= 0.6) return '0.60-0.75';
  if (score >= 0.4) return '0.40-0.60';
  return 'lt-0.40';
}

export async function inspectEgressKorean(input: InspectEgressKoreanInput): Promise<InspectEgressKoreanResult> {
  const sensitive = input.policy?.sensitivity === 'personal' || input.policy?.sensitivity === 'restricted' || !!input.memoDerived;
  const decisions: KoreanDecision[] = [];
  let relationSignal = false;
  const koreanByMsg = new Map<number, PrivacyFinding[]>();
  let degradedCode: string | null = null;
  try {
    for (let mi = 0; mi < input.messages.length; mi++) {
      const content = input.messages[mi].content;
      if (typeof content !== 'string' || !content) continue;
      if (hasLockedMarker(content)) continue;
      const judged = judgeKorean(content, {
        sensitiveSource: sensitive,
        ...(input.messages[mi].role !== 'system' ? { maxCandidates: EGRESS_JUDGE_MAX_CANDIDATES } : {}),
      });
      relationSignal = relationSignal || judged.relationSignal;
      if (judged.overflow > 0 && input.mode === 'enforce' && sensitive) {
        if (input.messages[mi].role === 'system') {
          degradedCode = degradedCode ?? 'korean-overflow-system-capped';
        } else {
          throw new PrivacyGatewayBlockedError(['korean-candidates-overflow']);
        }
      }
      if (input.clefInvoke) {
        // 휴리스틱 경로와 같은 상한을 써야 한다 — 기본 상한(8)에 걸린
        // 후보는 Clef 판정 자체를 받지 못해 enforce에서도 새어 나간다.
        const { candidates } = extractCandidates(
          content,
          input.messages[mi].role !== 'system' ? { maxCandidates: EGRESS_JUDGE_MAX_CANDIDATES } : undefined,
        );
        if (candidates.length > 0) {
          const scored = await classifyWithClef(input.clefInvoke, content, candidates);
          const findings: PrivacyFinding[] = [];
          scored.forEach((s, i) => {
            const act = actionFor(s.score, s.type, sensitive);
            decisions.push({ type: s.type, action: act, scoreBand: scoreBand(s.score) });
            void i;
            if (act === 'tokenize') findings.push({ type: s.type, level: 2, start: s.start, end: s.end, source: 'context', score: s.score });
          });
          if (input.mode === 'enforce') koreanByMsg.set(mi, findings);
        }
      } else {
        const findings: PrivacyFinding[] = [];
        judged.scored.forEach((s, i) => {
          const act = judged.actions[i];
          decisions.push({ type: s.type, action: act, scoreBand: scoreBand(s.score) });
          if (act === 'tokenize') findings.push({ type: s.type, level: 2, start: s.start, end: s.end, source: 'context', score: s.score });
        });
        if (input.mode === 'enforce') koreanByMsg.set(mi, findings);
      }
    }
  } catch (e) {
    if (e instanceof PrivacyGatewayBlockedError) throw e;
    if (e instanceof KoreanClassifierError) {
      if (input.mode === 'enforce' && sensitive) {
        throw new PrivacyGatewayBlockedError([e.reasonCode]);
      }
      degradedCode = e.reasonCode;
      koreanByMsg.clear();
    } else if (e instanceof PrivacyEngineError) {
      throw new PrivacyGatewayBlockedError(['engine-error']);
    } else {
      throw new PrivacyGatewayBlockedError(['engine-error']);
    }
  }
  try {
    const vault = new TokenVault();
    const reasons: string[] = [];
    if (degradedCode) reasons.push(`korean-degraded:${degradedCode}`);
    let level = 0;
    const allFindings: PrivacyFinding[] = [];
    for (const m of input.messages) {
      if (typeof m.content === 'string' && hasLockedMarker(m.content)) {
        return {
          action: 'block',
          messages: input.messages,
          level: 3,
          reasons: ['locked-source'],
          findings: [],
          vault,
          koreanDecisions: decisions,
          koreanMode: input.mode,
          relationSignal,
        };
      }
    }
    const crossSpans = detectCrossMessageSpans(
      input.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
    );
    const crossByMsg = new Map<number, typeof crossSpans>();
    for (const sp of crossSpans) {
      const arr = crossByMsg.get(sp.messageIndex) ?? [];
      arr.push(sp);
      crossByMsg.set(sp.messageIndex, arr);
    }
    const out = input.messages.map((m, mi) => {
      if (typeof m.content !== 'string') throw new PrivacyEngineError('non-string message content');
      if (!m.content) return m;
      const cls = classifyLevel({
        text: m.content,
        policySensitivity: input.policy?.sensitivity,
        memoDerived: input.memoDerived,
      });
      const cross = crossByMsg.get(mi) ?? [];
      const korean = input.mode === 'enforce' ? koreanByMsg.get(mi) ?? [] : [];
      const occupied = [...cls.findings, ...cross];
      const koreanExtra = korean.filter((k) => !occupied.some((f) => k.start < f.end && k.end > f.start));
      const extra = [
        ...cross.map(({ type, level: lv, start, end }) => ({ type, level: lv, start, end })),
        ...koreanExtra.map(({ type, level: lv, start, end }) => ({ type, level: lv, start, end })),
      ];
      const findings: PrivacyFinding[] = [
        ...cls.findings,
        ...extra.map(({ type, level: lv, start, end }) => ({ type, level: lv, start, end })),
      ];
      const msgLevel = Math.max(cls.level, ...extra.map((x) => x.level), 0);
      if (msgLevel > level) level = msgLevel;
      for (const f of findings) reasons.push(`pii:${f.type}:L${f.level}`);
      allFindings.push(...findings);
      if (msgLevel >= 2) {
        if (isStandaloneSecret(m.content, findings)) {
          reasons.push('l3-standalone-secret');
          return m;
        }
        const { text } = vault.sanitizeWith(m.content, extra);
        return { ...m, content: text };
      }
      return m;
    });
    if (reasons.includes('l3-standalone-secret')) {
      return {
        action: 'block',
        messages: input.messages,
        level,
        reasons,
        findings: allFindings,
        vault,
        koreanDecisions: decisions,
        koreanMode: input.mode,
        relationSignal,
      };
    }
    const action = level >= 2 ? 'tokenized' : 'allow';
    return {
      action,
      messages: out,
      level,
      reasons: [...new Set(reasons)],
      findings: allFindings,
      vault,
      koreanDecisions: decisions,
      koreanMode: input.mode,
      relationSignal,
    };
  } catch (e) {
    if (e instanceof PrivacyGatewayBlockedError) throw e;
    throw new PrivacyGatewayBlockedError(['engine-error']);
  }
}

export function inspectToolResult(text: string): {
  action: InspectEgressResult['action'];
  text: string;
  level: number;
  reasons: string[];
  vault: TokenVault;
} {
  const r = inspectEgress({ origin: 'tool-result', messages: [{ role: 'tool', content: text }] });
  return { action: r.action, text: r.messages[0]?.content ?? text, level: r.level, reasons: r.reasons, vault: r.vault };
}

export function canUseRelay(level: number): boolean {
  return level <= 1;
}
