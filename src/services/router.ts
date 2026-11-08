/**
 * MyHub Clef-flash router — review candidate, 2026-10-15.
 * Pure routing core; inject a Workers AI caller at the integration boundary.
 * Requires live Cloudflare and orchestrator integration tests before deployment.
 */

import { AI_GATEWAY_OPTIONS } from './ai-gateway';
import { inspectEgress } from './privacy-gateway';
import {
  CLEF_THRESHOLDS,
  COMPOUND_SPEC,
  HISTORY_SPEC,
  ROUTING_SPEC,
  enforceStateSize,
  isQuotaError,
  newTraceId,
  specHash,
} from './clef-engine';
import {
  extractClefPersona,
  inferClefPurpose,
  markClefUsageAccounted,
  recordClefUsage,
} from './clef-usage';

export const CLEF_MODEL = '@cf/cloudflare/clef-flash' as const;
export type PersonaId = 'lumi' | 'echo' | 'nova' | 'cali';
export type Category = 'chat' | 'summarize' | 'code' | 'schedule' | 'unclear';
export type RouteSource = 'explicit' | 'rule' | 'clef' | 'fallback';

export interface RouteResult {
  persona: PersonaId | null;
  source: RouteSource;
  reason: string;
  confidence?: number; // highest choice probability, NOT calibrated accuracy
  probabilities?: Record<string, number>;
  margin?: number;
  multiple?: number;
  needsHistory?: boolean;
  needsHistoryScore?: number;
  specHash?: string;
  traceId?: string;
  quotaExhausted?: boolean;
}

export interface RouteContext {
  previousPersona?: PersonaId;  // trusted server-side session metadata
  previousMessage?: string;     // user text only; redact secrets upstream
  lockedPersona?: PersonaId;    // only while an active workflow explicitly holds its routing lock
  writeActionPossible?: boolean; // set using trusted server-side signals
}

const CATEGORIES: Record<Category, string> = ROUTING_SPEC.criteria as Record<Category, string>;

const CATEGORY_TO_PERSONA: Record<Exclude<Category, 'unclear'>, PersonaId> = {
  chat: 'lumi',
  summarize: 'echo',
  code: 'nova',
  schedule: 'cali',
};

export type ClefRequest = {
  model: 'clef-flash';
  state: Record<string, unknown>;
  questions: {
    assistant: {
      type: 'choice';
      instructions: string;
      criteria: Record<Category, string>;
    };
    multiple_actions: {
      type: 'noul';
      instructions: string;
      criteria: Record<string, string>;
    };
    // 2026-10-15: 배치화 - history 필요 여부 (선택적)
    needs_history?: {
      type: 'noul';
      instructions: string;
      criteria: Record<string, string>;
    };
  };
};

// Adapt actual env.AI.run() once, at the call site. This lets the entire
// router be typechecked/tested without an unbounded `as any` cast.
export type ClefInvoker = (request: ClefRequest) => Promise<unknown>;

/**
 * Clef invoker 팩토리 — env.AI.run() 호출을 한 곳에서 만든다.
 * AI Gateway 관측성(트랙 B2): 모든 Clef 호출에 gateway 옵션을 단다.
 * 호출처(src/modules/ai/routes.ts, src/index.ts)는 이 팩토리만 쓴다.
 */
export interface ClefUsageOptions {
  db?: D1Database;
  persona?: string;
}

export function createClefInvoker(
  ai: { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> },
  usageOpts?: ClefUsageOptions,
): ClefInvoker {
  const db = usageOpts?.db;
  if (!db) {
    return (request) => ai.run(CLEF_MODEL, request, AI_GATEWAY_OPTIONS);
  }
  const invoker = async (request: ClefRequest) => {
    const t0 = Date.now();
    const base = {
      purpose: inferClefPurpose(request),
      request,
      persona: usageOpts?.persona ?? extractClefPersona(request),
    };
    try {
      const raw = await ai.run(CLEF_MODEL, request, AI_GATEWAY_OPTIONS);
      await recordClefUsage(db, { ...base, latencyMs: Date.now() - t0, outcome: 'success', raw });
      return raw;
    } catch (e) {
      await recordClefUsage(db, { ...base, latencyMs: Date.now() - t0, outcome: 'failed' });
      throw e;
    }
  };
  return markClefUsageAccounted(invoker) as ClefInvoker;
}

export function isValidPersonaId(id: unknown): id is PersonaId {
  return id === 'lumi' || id === 'echo' || id === 'nova' || id === 'cali';
}

function isCategory(id: string): id is Category {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, id);
}

const MENTION = /(?:^|[\s([{])@(루미|에코|노바|캘리|lumi|echo|nova|cali|calli)(?![\p{L}\p{N}_])/giu;
const MENTION_IDS: Record<string, PersonaId> = {
  '루미': 'lumi', lumi: 'lumi',
  '에코': 'echo', echo: 'echo',
  '노바': 'nova', nova: 'nova',
  '캘리': 'cali', cali: 'cali', calli: 'cali',
};

function mentionedPersonas(message: string): PersonaId[] {
  const ids = new Set<PersonaId>();
  for (const match of message.matchAll(MENTION)) {
    const id = MENTION_IDS[match[1].toLowerCase()];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** A single unique explicit mention; ambiguous multiple mentions return null. */
export function extractMention(message: string): PersonaId | null {
  const ids = mentionedPersonas(message);
  return ids.length === 1 ? ids[0] : null;
}

function looksLikeWriteAction(message: string): boolean {
  const object = /(일정|약속|회의|할\s*일|메모|기록|알림|리마인더|예약)/;
  const verb = /(등록|추가|삭제|취소|수정|변경|저장|예약|설정|만들어|생성)/;
  return object.test(message) && verb.test(message);
}

function fallback(message: string, context: RouteContext, reason: string): RouteResult {
  // A fallback decision never implies permission to execute a tool.
  if (context.writeActionPossible || looksLikeWriteAction(message)) {
    return { persona: null, source: 'fallback', reason };
  }
  return { persona: 'lumi', source: 'fallback', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validates both required answers. Never silently treat missing 'noul' as 0. */
function readAnswer(raw: unknown):
  | { category: Exclude<Category, 'unclear'> | 'unclear'; top: number; second: number; multiple: number; probabilities: Record<string, number>; needsHistory?: number }
  | null {
  if (!isRecord(raw) || !isRecord(raw.answers)) return null;
  const assistant = raw.answers.assistant;
  const multi = raw.answers.multiple_actions;
  if (!isRecord(assistant) || assistant.type !== 'choice' || !isRecord(multi) || multi.type !== 'noul') return null;
  if (typeof assistant.choice !== 'string' || !isCategory(assistant.choice)) return null;
  if (!isRecord(assistant.probabilities) || !isProbability(multi.noul)) return null;
  if (assistant.confidence !== undefined && !isProbability(assistant.confidence)) return null;

  const allowed = Object.keys(CATEGORIES) as Category[];
  const entries: [Category, number][] = [];
  for (const id of allowed) {
    const p = assistant.probabilities[id];
    if (!isProbability(p)) return null;
    entries.push([id, p]);
  }
  // Reject unexpected choices and grossly malformed probability distributions.
  if (Object.keys(assistant.probabilities).some((id) => !isCategory(id))) return null;
  const sum = entries.reduce((s, [, p]) => s + p, 0);
  if (Math.abs(sum - 1) > 0.03) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [category, top] = entries[0];
  if (assistant.choice !== category) return null;
  let needsHistory: number | undefined;
  const hist = (raw.answers as Record<string, unknown>).needs_history;
  if (hist && typeof hist === 'object' && (hist as Record<string, unknown>).type === 'noul' && isProbability((hist as Record<string, unknown>).noul)) needsHistory = (hist as Record<string, unknown>).noul as number;
  return { category, top, second: entries[1][1], multiple: multi.noul, probabilities: Object.fromEntries(entries), needsHistory };
}

function reducedMessage(message: string): string {
  // A long document/code block is not needed just to select a persona.
  if (message.length <= 3500) return message;
  return message.slice(0, 1000) + '\n[중간 내용 생략]\n' + message.slice(-2000);
}

const GREETING = /^(?:안녕|안녕하세요|하이|hi|hello)[!?.~\s]*$/iu;
const CONTINUE = /^(?:계속|계속해|이어서\s*해줘|더\s*자세히\s*설명해줘)[!?.~\s]*$/u;

// 2026-10-15: GPT 권고 - 규칙 기반 조기 종료 확대
// Clef 호출 없이 정적 응답으로 처리 (비용 절감, 속도 향상)
const STATIC_RESPONSES: Record<string, string> = {
  '고마워': '도움이 되었다니 다행입니다.',
  '감사합니다': '천만에요. 또 도와드릴 일이 있으면 말씀해주세요.',
  '감사해': '천만에요.',
  'thanks': 'You\'re welcome!',
  'thank you': 'You\'re welcome!',
};

function getStaticResponse(message: string, activeWorkflow: boolean): { text: string; persona: PersonaId } | null {
  if (activeWorkflow) return null;
  
  const normalized = message
    .normalize('NFKC')
    .trim()
    .replace(/[.!?。！？]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  
  const response = STATIC_RESPONSES[normalized];
  if (response) {
    return { text: response, persona: 'lumi' };
  }
  return null;
}

export async function classifyIntent(
  invoke: ClefInvoker,
  userMessage: string,
  context: RouteContext = {},
): Promise<RouteResult> {
  const message = userMessage.trim();
  if (!message) return { persona: null, source: 'rule', reason: 'empty_message' };
  if (GREETING.test(message) && !context.lockedPersona) {
    return { persona: 'lumi', source: 'rule', reason: 'greeting' };
  }
  // 2026-10-15: 정적 응답 조기 종료 (Clef 호출 생략)
  const staticResp = getStaticResponse(message, !!context.lockedPersona);
  if (staticResp) {
    return { persona: staticResp.persona, source: 'rule', reason: 'static_response' };
  }
  if (context.previousPersona && CONTINUE.test(message)) {
    return { persona: context.previousPersona, source: 'rule', reason: 'active_workflow_continuation' };
  }

  const gate = inspectEgress({
    origin: 'clef',
    messages: [
      { role: 'user', content: message },
      { role: 'user', content: context.previousMessage ?? '' },
    ],
  });
  if (gate.action === 'block') {
    return fallback(message, context, 'privacy_blocked');
  }
  const safeCurrent = gate.messages[0].content as string;
  const safePrevious = gate.messages[1].content as string;

  const input: ClefRequest = {
    model: 'clef-flash',
    // R-26: 운영 경로에도 엔진과 같은 state 상한(MAX_STATE_CHARS)을 적용한다.
    // reducedMessage(3500자)+previous(800자)만으로는 JSON이 상한을 넘을 수 있다.
    state: enforceStateSize({
      current_message: reducedMessage(safeCurrent),
      previous_message: safePrevious.slice(-800),
      previous_persona: context.previousPersona ?? null,
      active_workflow: context.lockedPersona !== undefined,
    }),
    // R-26/P-09: 전송 지시문·criteria는 정본 스펙 상수 그 자체다. 인라인 사본을
    // 두면 specHash가 가리키는 스펙과 실제 전송문이 어긋나고(해시 정합 깨짐),
    // 스펙의 "판단할 수 없으면 unclear를 고르라" 탈출 문장이 운영 전송문에서
    // 빠지는 일이 생긴다. 스펙을 고치면 전송문과 해시가 함께 바뀐다.
    questions: {
      assistant: {
        type: 'choice',
        instructions: ROUTING_SPEC.instructions,
        criteria: CATEGORIES,
      },
      multiple_actions: {
        type: 'noul',
        instructions: COMPOUND_SPEC.instructions,
        criteria: COMPOUND_SPEC.criteria,
      },
      // 2026-10-15: 배치화 - history 필요 여부를 같은 호출에서 판단
      needs_history: {
        type: 'noul',
        instructions: HISTORY_SPEC.instructions,
        criteria: HISTORY_SPEC.criteria,
      },
    },
  };

  let response: unknown;
  try {
    response = await invoke(input);
  } catch (e) {
    if (isQuotaError(e)) {
      const f = fallback(message, context, 'quota_exhausted');
      return { ...f, quotaExhausted: true };
    }
    return fallback(message, context, 'provider_error');
  }

  const result = readAnswer(response);
  if (!result) return fallback(message, context, 'invalid_response');
  const ext = { probabilities: result.probabilities, margin: result.top - result.second, multiple: result.multiple, needsHistory: result.needsHistory !== undefined ? result.needsHistory >= 0.5 : undefined, needsHistoryScore: result.needsHistory, specHash: specHash([ROUTING_SPEC, COMPOUND_SPEC, HISTORY_SPEC]), traceId: newTraceId() };
  if (result.multiple >= CLEF_THRESHOLDS.compoundNoul) {
    return { persona: null, source: 'fallback', reason: 'multiple_actions', confidence: result.top, ...ext };
  }
  if (result.category === 'unclear' || result.top < CLEF_THRESHOLDS.routingTop || result.top - result.second < CLEF_THRESHOLDS.routingMargin) {
    return { persona: null, source: 'fallback', reason: 'low_confidence', confidence: result.top, ...ext };
  }
  return {
    persona: CATEGORY_TO_PERSONA[result.category],
    source: 'clef',
    reason: 'classified',
    confidence: result.top,
    ...ext,
  };
}

/** The top-level entry point, used by orchestrator (not classifyIntent directly). */
export async function routeMessage(
  invoke: ClefInvoker,
  userMessage: string,
  context: RouteContext = {},
): Promise<RouteResult> {
  if (!userMessage.trim()) {
    return { persona: null, source: 'rule', reason: 'empty_message' };
  }
  const explicit = mentionedPersonas(userMessage);
  if (explicit.length > 1) {
    return { persona: null, source: 'explicit', reason: 'ambiguous_mentions' };
  }
  if (explicit.length === 1) {
    return { persona: explicit[0], source: 'explicit', reason: 'explicit_mention' };
  }
  // Explicit mentions take precedence over a locked workflow.
  // A verified active workflow should usually remain on the same persona.
  if (context.lockedPersona) {
    return { persona: context.lockedPersona, source: 'rule', reason: 'active_workflow_lock' };
  }
  return classifyIntent(invoke, userMessage, context);
}

// Do not export an empty KeywordRouter here. Keep the actual legacy
// implementation available until all orchestrator call sites are migrated.
