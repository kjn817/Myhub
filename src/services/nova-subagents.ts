// 노바의 모델별 서브에이전트 시스템 (2026-10-15)
// AI 스튜디오 내에서 노바가 각 모델을 서브에이전트로 활용

import type { DelegationManifest } from './subagent-orchestrator';

// 사용 가능한 모델별 서브에이전트 정의
// 2026-10-30: 'nvidia-ultra' 제거 — NVIDIA 운영 경로 완전 제외로 추천·선택
// 대상에서 빠졌다 (정의 자체를 남기면 Clef 선택지로 부활할 수 있어 삭제).
export type SubAgentModel = 'gemini-flash' | 'gemini-pro' | 'groq-fast' | 'workers-llama';

export interface ModelSubAgent {
  id: SubAgentModel;
  name: string;
  modelId: string;
  provider: 'gemini' | 'groq' | 'nvidia' | 'workers-ai';
  strengths: string[];
  bestFor: string[];
  maxTokens: number;
  speed: 'fast' | 'medium' | 'slow';
  cost: 'low' | 'medium' | 'high';
}

export const MODEL_SUBAGENTS: Record<SubAgentModel, ModelSubAgent> = {
  'gemini-flash': {
    id: 'gemini-flash',
    name: '플래시',
    modelId: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    strengths: ['빠른 응답', '한국어 우수', '코드 생성'],
    bestFor: ['코드 생성', '빠른 프로토타이핑', '일반 대화'],
    maxTokens: 8000,
    speed: 'fast',
    cost: 'low',
  },
  'gemini-pro': {
    id: 'gemini-pro',
    name: '프로',
    modelId: 'gemini-3.5-flash-lite', // Pro 모델이 없으므로 flash로 대체
    provider: 'gemini',
    strengths: ['균형잡힌 성능', '안정적'],
    bestFor: ['복잡한 로직', '리팩토링'],
    maxTokens: 8000,
    speed: 'medium',
    cost: 'low',
  },
  'groq-fast': {
    id: 'groq-fast',
    name: '스피드',
    modelId: 'openai/gpt-oss-120b',
    provider: 'groq',
    strengths: ['초고속 추론', '120B 파라미터'],
    bestFor: ['코드 리뷰', '빠른 검증', '문법 체크'],
    maxTokens: 4000,
    speed: 'fast',
    cost: 'low',
  },
  'workers-llama': {
    id: 'workers-llama',
    name: '라마',
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    provider: 'workers-ai',
    strengths: ['Cloudflare 네이티브', '추가 API 키 불필요'],
    bestFor: ['간단한 작업', '폴백용'],
    maxTokens: 4000,
    speed: 'medium',
    cost: 'low',
  },
};

// 작업 유형별 최적 서브에이전트 추천 (규칙 기반)
export function recommendSubAgent(taskType: string): SubAgentModel[] {
  const task = taskType.toLowerCase();
  
  if (task.includes('리뷰') || task.includes('검증') || task.includes('체크')) {
    return ['groq-fast', 'gemini-flash']; // 빠른 모델 우선
  }
  if (task.includes('설계') || task.includes('아키텍처') || task.includes('문서')) {
    return ['gemini-pro', 'workers-llama']; // 큰 모델 우선 (2026-10-30: nvidia-ultra 제거 → 차순위 승격)
  }
  if (task.includes('생성') || task.includes('만들')) {
    return ['gemini-flash', 'gemini-pro']; // 코드 생성 특화
  }
  if (task.includes('빠른') || task.includes('간단')) {
    return ['groq-fast', 'workers-llama']; // 속도 우선
  }
  
  return ['gemini-flash']; // 기본값
}

// Clef로 서브에이전트 선택 (노바가 결정하도록)
export async function selectSubAgentByClef(
  invoke: import('./router').ClefInvoker,
  taskDescription: string
): Promise<SubAgentModel> {
  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: taskDescription },
    questions: {
      subagent: {
        type: 'choice',
        instructions: '이 작업에 가장 적합한 서브에이전트를 선택하라.',
        criteria: {
          'gemini-flash': '플래시: 빠른 코드 생성, 한국어 우수',
          'groq-fast': '스피드: 초고속 코드 리뷰/검증',
          'workers-llama': '라마: 간단한 작업, Cloudflare 네이티브',
        },
      } as any,
    },
  } as any)) as any;

  const choice = response?.answers?.subagent?.choice;
  if (choice && MODEL_SUBAGENTS[choice as SubAgentModel]) {
    return choice as SubAgentModel;
  }
  // 폴백: 규칙 기반
  return recommendSubAgent(taskDescription)[0];
}

export interface SubAgentTask {
  agentId: SubAgentModel;
  manifest: DelegationManifest;
  priority: number;
}

// 노바가 서브에이전트들에게 작업 분배하는 플랜
export function planSubAgentWork(
  mainObjective: string,
  subTasks: Array<{ type: string; description: string }>,
  parentRequestId: string
): SubAgentTask[] {
  return subTasks.map((task, i) => {
    const recommended = recommendSubAgent(task.type);
    const agentId = recommended[0];
    const agent = MODEL_SUBAGENTS[agentId];
    
    return {
      agentId,
      manifest: {
        objective: task.description,
        constraints: [
          `서브에이전트: ${agent.name} (${agent.modelId})`,
          `최대 토큰: ${agent.maxTokens}`,
          '결과는 구조화 요약으로 반환',
        ],
        maxTokens: agent.maxTokens,
        allowedTools: [],
        context: { mainObjective, taskType: task.type },
        parentRequestId: `${parentRequestId}-sub-${i}`,
      },
      priority: i,
    };
  });
}
