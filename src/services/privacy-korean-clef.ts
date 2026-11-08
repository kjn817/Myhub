import { PrivacyEngineError } from './privacy-engine';
import type { KoreanCandidate, KoreanCandidateType, ScoredKoreanCandidate } from './privacy-korean';

export class KoreanClassifierError extends PrivacyEngineError {
  constructor(reasonCode: string) {
    super(`korean-classifier:${reasonCode}`);
    this.reasonCode = reasonCode;
    this.name = 'KoreanClassifierError';
  }

  readonly reasonCode: string;
}

export interface ClefNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ClefInvokeRequest {
  model: string;
  state: {
    current_message: string;
    previous_message: string;
    previous_persona: null;
    active_workflow: boolean;
  };
  questions: Record<string, ClefNoulQuestion>;
}

export type ClefInvoke = (request: ClefInvokeRequest) => Promise<unknown>;

const CRITERIA: Record<KoreanCandidateType, { instructions: string; trueDef: string; falseDef: string }> = {
  NAME: {
    instructions: "\uC544\uB798 \uBB38\uC7A5\uC5D0\uC11C \uD45C\uC2DC\uB41C \uAD6C\uAC04\uC774 \uD2B9\uC815 \uAC1C\uC778\uC758 \uC131\uBA85(\uC131+\uC774\uB984 \uC804\uCCB4)\uC778\uAC00?",
    trueDef: "\uD2B9\uC815 \uAC1C\uC778 \uD55C \uC0AC\uB78C\uC744 \uAC00\uB9AC\uD0A4\uB294 \uC131\uBA85\uC774\uB2E4.",
    falseDef: "\uC9C1\uD568\uB9CC, \uC9C0\uBA85, \uC0C1\uD638, \uC74C\uC2DD\xB7\uC0AC\uBB3C \uC774\uB984, \uC77C\uBC18 \uBA85\uC0AC, \uC608\uC2DC \uC774\uB984(\uD64D\uAE38\uB3D9)\uC740 \uC131\uBA85\uC774 \uC544\uB2C8\uB2E4."
  },
  ADDRESS: {
    instructions: "\uC544\uB798 \uBB38\uC7A5\uC5D0\uC11C \uD45C\uC2DC\uB41C \uAD6C\uAC04\uC774 \uD2B9\uC815 \uAC1C\uC778\xB7\uC138\uB300\uB97C \uC2DD\uBCC4\uD560 \uC218 \uC788\uB294 \uC2E4\uC81C \uC8FC\uC18C\uC778\uAC00?",
    trueDef: "\uC2DC/\uB3C4\xB7\uC2DC\uAD70\uAD6C\xB7\uB3C4\uB85C\uBA85\xB7\uAC74\uBB3C\uBC88\uD638\xB7\uB3D9/\uD638 \uC911 \uB458 \uC774\uC0C1\uC774 \uACB0\uD569\uD574 \uD2B9\uC815 \uC7A5\uC18C\uB97C \uC2DD\uBCC4\uD558\uB294 \uC8FC\uC18C\uC774\uB2E4.",
    falseDef: "\uB3C4\uB85C\uBA85 \uB2E8\uB3C5 \uC778\uC6A9, \uAC74\uBB3C\uBA85 \uB2E8\uB3C5, \uACF5\uAC1C \uD589\uC0AC \uC7A5\uC18C, \uAD50\uD1B5 \uC548\uB0B4 \uC18D \uC9C0\uBA85\uC740 \uC2DD\uBCC4 \uC8FC\uC18C\uAC00 \uC544\uB2C8\uB2E4."
  },
  RELATION: {
    instructions: "\uC544\uB798 \uBB38\uC7A5\uC5D0\uC11C \uD45C\uC2DC\uB41C \uAD6C\uAC04\uC774 \uAD00\uACC4\xB7\uC18C\uC18D \uD45C\uD604\uACFC \uACB0\uD569\uD574 \uD2B9\uC815 \uAC1C\uC778\uC744 \uC881\uD600 \uAC00\uB9AC\uD0A4\uB294\uAC00?",
    trueDef: "\uC131\uC528+\uC9C1\uD568, \uC18C\uC18D+\uC9C1\uD568, \uAC00\uC871\uAD00\uACC4+\uC131\uC528/\uC9C1\uD568\uCC98\uB7FC \uACB0\uD569 \uC790\uCCB4\uB85C \uD2B9\uC815\uC778 1\uBA85\uC744 \uC881\uD78C\uB2E4.",
    falseDef: "\uAD00\uACC4\uC5B4 \uB2E8\uB3C5, \uC9C1\uD568 \uB2E8\uB3C5, \uD2B9\uC815\uC778 \uB2E8\uC11C\uAC00 \uC5C6\uB294 \uC77C\uBC18 \uC5C5\uBB34 \uD45C\uD604\uC740 \uD574\uB2F9\uD558\uC9C0 \uC54A\uB294\uB2E4."
  }
};

const HARD_TIMEOUT_MS = 1500;

function windowFor(text: string, c: KoreanCandidate): string {
  const from = Math.max(0, c.start - 120);
  const to = Math.min(text.length, c.end + 120);
  const win = text.slice(from, to);
  const span = text.slice(c.start, c.end);
  return win.replace(span, `⟦${span}⟧`).slice(0, 300);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isProb(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export async function classifyWithClef(
  invoke: ClefInvoke,
  text: string,
  candidates: KoreanCandidate[],
  opts?: { timeoutMs?: number },
): Promise<ScoredKoreanCandidate[]> {
  if (candidates.length === 0) return [];
  const questions: Record<string, ClefNoulQuestion> = {};
  candidates.forEach((c, i) => {
    const crit = CRITERIA[c.type];
    questions[`cand_${i}`] = {
      type: 'noul',
      instructions: `${crit.instructions} 문맥: ${windowFor(text, c)}`,
      criteria: { true: crit.trueDef, false: crit.falseDef },
    };
  });
  const request: ClefInvokeRequest = {
    model: 'clef-flash',
    state: { current_message: text.slice(0, 300), previous_message: '', previous_persona: null, active_workflow: false },
    questions,
  };
  const timeoutMs = opts?.timeoutMs ?? HARD_TIMEOUT_MS;
  let raw: unknown;
  try {
    raw = await Promise.race([
      invoke(request),
      new Promise<never>((_, reject) => setTimeout(() => reject(new KoreanClassifierError('context-timeout')), timeoutMs)),
    ]);
  } catch (e) {
    if (e instanceof KoreanClassifierError) throw e;
    const msg = String((e as { message?: unknown } | null)?.message ?? e);
    if (/3036|4006|quota|neuron/i.test(msg)) throw new KoreanClassifierError('context-quota');
    if (/3040|capacity|overloaded/i.test(msg)) throw new KoreanClassifierError('context-capacity');
    throw new KoreanClassifierError('context-unavailable');
  }
  if (!isRecord(raw) || !isRecord(raw.answers)) throw new KoreanClassifierError('context-malformed');
  const out: ScoredKoreanCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const ans = raw.answers[`cand_${i}`];
    if (!isRecord(ans) || ans.type !== 'noul' || !isProb(ans.noul)) {
      throw new KoreanClassifierError('context-malformed');
    }
    out.push({ ...candidates[i], score: ans.noul });
  }
  return out;
}
