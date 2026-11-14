// 서브에이전트 오케스트레이션 패턴 (2026-10-15)
// GitHub 리서치 기반: DelegationManifest + 실행 토폴로지 + 구조화 요약
// 참고: openai-agents-js (Triage/Handoff), gemini-elite-core (DelegationManifest),
//       cognition-9 (3 topologies), joker7531/orchestrator (wrapper pattern)

import type { PersonaId } from './router';

/** 위임 매니페스트 토큰 예산 상한 (S5-4, 5-9) — 초과 시 검증 위반. */
const MAX_MANIFEST_TOKENS = 8000;

// ---------------------------------------------------------------------------
// 1. DelegationManifest: 구조화된 위임 (gemini-elite-core 패턴)
// ---------------------------------------------------------------------------

export interface DelegationManifest {
  objective: string;           // 명확한 목표 ("이것 고쳐" 금지)
  constraints: string[];       // 제약 조건
  maxTokens: number;           // 토큰 예산
  allowedTools: string[];      // 허용 도구
  context: Record<string, unknown>; // 최소 컨텍스트만 (Context Distillation)
  parentRequestId: string;     // 추적용
}

export function createManifest(
  objective: string,
  persona: PersonaId,
  parentRequestId: string,
  context: Record<string, unknown> = {}
): DelegationManifest {
  // 비서별 기본 제약
  const constraints: Record<PersonaId, string[]> = {
    lumi: ['개인정보 마스킹 유지', '잠긴 메모 접근 금지'],
    echo: ['요약은 원문 기반', '추측 금지', '잠긴 메모 제외'],
    nova: ['생성 코드는 실행 가능해야 함', '보안 취약점 금지'],
    cali: ['일정 중복 확인', '과거 일정 수정 시 확인'],
  };

  return {
    objective,
    constraints: constraints[persona] || [],
    maxTokens: 4000,
    allowedTools: [], // 호출자가 설정
    context, // 최소한만 전달
    parentRequestId,
  };
}

// ---------------------------------------------------------------------------
// 2. 실행 토폴로지 3종 (cognition-9 패턴)
// ---------------------------------------------------------------------------

export type Topology = 'parallel' | 'sequential' | 'hub-and-spoke';

export interface SubTask {
  id: string;
  persona: PersonaId;
  manifest: DelegationManifest;
  dependsOn?: string[];  // sequential용
}

export interface OrchestrationPlan {
  topology: Topology;
  tasks: SubTask[];
  reason: string;
}

/**
 * 복합 요청을 실행 토폴로지로 분류
 * - parallel: 독립 작업 동시 실행 (예: "회의 등록하고 요약해줘")
 * - sequential: 순서 의존성 있음 (예: "앱 만들고 테스트해줘")
 * - hub-and-spoke: 중앙에서 분산 후 취합 (예: "3개 주제 리서치해줘")
 */
export function planTopology(
  tasks: Array<{ persona: PersonaId; objective: string }>,
  parentRequestId: string
): OrchestrationPlan {
  // 의존성 힌트 키워드
  const sequentialHints = ['그 다음', '그리고 나서', '완료 후', '테스트해줘', '확인해줘'];
  const hasDependency = tasks.some(t => 
    sequentialHints.some(h => t.objective.includes(h))
  );

  // 병렬 가능: 서로 다른 비서, 의존성 없음
  const personas = new Set(tasks.map(t => t.persona));
  const isIndependent = personas.size === tasks.length && !hasDependency;

  let topology: Topology;
  let reason: string;

  if (tasks.length === 1) {
    topology = 'hub-and-spoke';
    reason = '단일 작업';
  } else if (isIndependent) {
    topology = 'parallel';
    reason = '독립 작업 병렬 실행';
  } else if (hasDependency) {
    topology = 'sequential';
    reason = '순서 의존성 감지';
  } else {
    topology = 'hub-and-spoke';
    reason = '중앙 오케스트레이션';
  }

  const subTasks: SubTask[] = tasks.map((t, i) => ({
    id: `task-${i}`,
    persona: t.persona,
    manifest: createManifest(t.objective, t.persona, parentRequestId),
    dependsOn: topology === 'sequential' && i > 0 ? [`task-${i-1}`] : undefined,
  }));

  return { topology, tasks: subTasks, reason };
}

// ---------------------------------------------------------------------------
// 3. 구조화 요약 핸드오프 (joker7531/orchestrator 패턴)
// ---------------------------------------------------------------------------

export interface StructuredSummary {
  summary: string;           // 압축된 요약 (원문 아님)
  keyPoints: string[];       // 핵심 포인트
  files?: string[];          // 관련 파일
  openQuestions?: string[];  // 미해결 질문
  success: boolean;
}

/**
 * 서브에이전트 결과를 구조화 요약으로 압축
 * 메인 에이전트는 원문이 아닌 요약만 봄 (토큰 절감)
 */
export function createSummary(
  rawResult: string,
  maxLength: number = 500
): StructuredSummary {
  // 간단한 휴리스틱 요약 (실제로는 LLM으로 압축)
  const lines = rawResult.split('\n').filter(l => l.trim());
  const summary = lines.slice(0, 3).join(' ').slice(0, maxLength);
  
  return {
    summary,
    keyPoints: lines.filter(l => l.match(/^[•\-\*]\s/) || l.includes(':')).slice(0, 5),
    success: !rawResult.toLowerCase().includes('error') && !rawResult.toLowerCase().includes('실패'),
  };
}

// ---------------------------------------------------------------------------
// 4. 안티패턴 검증 (gemini-elite-core 5계명)
// ---------------------------------------------------------------------------

export function validateDelegation(manifest: DelegationManifest): string[] {
  const violations: string[] = [];
  
  // 1. 목표 없이 위임 금지
  if (!manifest.objective || manifest.objective.length < 10) {
    violations.push('목표가 불명확함 (10자 이상 필요)');
  }
  if (/^(이것|그것|저것)\s*(고쳐|해줘)/.test(manifest.objective)) {
    violations.push('모호한 지시 금지 ("이것 고쳐" 등)');
  }
  
  // 2. 전체 컨텍스트 전달 금지 (Context Distillation)
  const contextSize = JSON.stringify(manifest.context).length;
  if (contextSize > 10000) {
    violations.push(`컨텍스트 과다 (${contextSize}자 > 10000자 제한)`);
  }
  
  // 3. 토큰 예산 확인
  if (manifest.maxTokens > MAX_MANIFEST_TOKENS) {
    violations.push(`토큰 예산 과다 (${MAX_MANIFEST_TOKENS} 초과)`);
  }
  
  return violations;
}
