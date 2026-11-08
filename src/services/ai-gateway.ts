/**
 * Cloudflare AI Gateway 통합 관측성 (트랙 B2, 2026-10-26)
 *
 * 근거: docs/github-apply-research-20261026.md 1-5절.
 * 2026-08-07 Cloudflare 변경 로그 — Workers AI와 AI Gateway가 단일 AI 컨트롤
 * 플레인으로 통합됐다. `env.AI.run(model, input, { gateway: { id } })`로 호출하면
 * 게이트웨이가 로그·분석(볼륨·오류·지연·토큰·비용)·캐시·속도 제한·재시도를 제공한다.
 *
 * 게이트웨이 "default"는 사전 생성이 필요 없다 — 공식 문서 기준, 첫 인증 요청 시
 * 자동 생성된다 ("Use `default` to automatically create a gateway on the first
 * authenticated request"). 대시보드·API 생성 불필요, 별도 비용·카드 없음.
 * (2026-10-26 확인: 현 API 토큰으로 ai-gateway 목록 조회 시 403 — 토큰에 AI Gateway
 * 권한이 없어서이며, 자동 생성 특성상 적용의 차단 요소가 아니다.)
 *
 * 과금 주의: 게이트웨이 경유 Workers AI 호출은 기본적으로 기존 Workers AI 과금과
 * 동일하다. "Unified billing"(선불 AI Gateway 크레딧으로 Workers AI 결제)은
 * 게이트웨이별 대시보드 설정으로, 이 트랙에서 건드리지 않는다 — 별도 판단 사항.
 *
 * 범위: Workers AI 바인딩(`env.AI.run`) 호출 경로만. 외부 프로바이더(Gemini·Groq·
 * NVIDIA 직접 호출)는 키 관리·ZDR 등 보안 경계와 맞물려 있어 이 트랙에서 이동하지
 * 않는다. `WorkersAIAdapter`의 OpenAI 호환 REST 경로(`api.cloudflare.com/.../ai/v1`)
 * 도 `env.AI.run`이 아니라서 그대로 둔다 — 게이트웨이 URL 경유는 별도 판단.
 *
 * 지연 전후 비교 (배포 후 라이브 검증 시):
 * - D1 `ai_usage`의 `latency_ms` 분포를 배포 전후로 비교한다. 배포 시점을 기준으로
 *   provider·model·capability별 평균·최대·1초 이내 비중·성공률(outcome)을 나눠 본다
 *   (SQL 예시는 docs/ai-gateway-observability-20261026.md 참조).
 * - 주의: `ai_usage`에는 게이트웨이 캐시 히트 여부 컬럼이 없다. 캐시된 요청은
 *   지연이 짧게 찍히므로, 전후 비교는 게이트웨이 대시보드 Analytics(캐시 히트율·
 *   지연)와 함께 봐야 한다. 게이트웨이 경유 자체가 지연을 늘리면 p95보다 평균·
 *   1초 이내 비중이 먼저 움직인다.
 * - 대조군: 외부 프로바이더(Gemini·Groq·NVIDIA)는 호출 경로가 바뀌지 않으므로
 *   같은 기간의 지연 분포를 대조군으로 삼을 수 있다.
 */

/** AI Gateway ID — "default"는 첫 인증 요청 시 자동 생성된다 (사전 생성 불필요). */
export const AI_GATEWAY_ID = 'default' as const

/** 모든 Workers AI(`env.AI.run`) 호출에 다는 공통 옵션 — 한 곳에서만 정의한다. */
export const AI_GATEWAY_OPTIONS = { gateway: { id: AI_GATEWAY_ID, collectLog: false } } as const
