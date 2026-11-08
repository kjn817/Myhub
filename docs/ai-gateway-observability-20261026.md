# Cloudflare AI Gateway 통합 관측성 — 적용 기록 (2026-10-26, 트랙 B2)

> 근거: `docs/github-apply-research-20261026.md` 1-5절 (2026-08-07 통합).
> 상태: 코드 적용 완료, 미배포. 라이브 검증은 배포 후 별도 진행.

## 적용한 것

모든 Workers AI 바인딩(`env.AI.run`) 호출에 `gateway: { id: "default" }` 옵션을 단다.
옵션은 `src/services/ai-gateway.ts`의 `AI_GATEWAY_OPTIONS` 한 곳에서만 정의하고,
각 호출처가 이를 참조한다 (하드코딩 분산 금지).

| 호출 위치 | 용도 | 적용 방식 |
|---|---|---|
| `src/services/ai.ts` `callWorkersAI` | 비서 채팅·요약 등 Workers AI 모델 호출 | `ai.run(model, params, AI_GATEWAY_OPTIONS)` |
| `src/services/voice.ts` `transcribeAudio` | Whisper STT | 3번째 인자 추가 |
| `src/services/voice.ts` `synthesizeSpeech` | MeloTTS TTS | 3번째 인자 추가 |
| `src/ai/providers/workers-ai.ts` `nextNative` | WorkersAIAdapter Native 경로 | 3번째 인자 추가 |
| `src/ai/fc-test.ts` `testFunctionCalling` | FC 실증 테스트 헬퍼 | 3번째 인자 추가 |
| `src/services/router.ts` `createClefInvoker` | Clef-flash 라우터 invoker (신설 팩토리) | 팩토리 내부에서 옵션 적용 |
| `src/modules/ai/routes.ts` / `src/index.ts` | Clef invoker 호출처 2곳 | `createClefInvoker(env.AI)`로 교체 (중복 제거) |

`src/index-inline.ts`는 `deploy_full.py`가 `src/index.ts`에서 재생성하는 파일이라
직접 고치지 않았다 — 다음 배포 시 자동 반영된다.

## 게이트웨이 "default"는 사전 생성이 필요 없다

- 공식 문서(Workers Bindings·2026-08-07 변경 로그): `id: "default"`는
  "첫 인증 요청 시 자동 생성된다 (automatically create a gateway on the first
  authenticated request)". 대시보드·API 생성 불필요, 별도 비용·카드 없음.
- 2026-10-26 확인: 현 API 토큰으로 `GET /accounts/{id}/ai-gateway/gateways` 조회 시
  403 (`Authentication error`, code 10000). 토큰 자체는 유효·활성
  (`/user/tokens/verify` 200)이나 AI Gateway 권한이 없다. 자동 생성 특성상
  적용의 차단 요소가 아니다. 게이트웨이 목록·로그를 API로 보려면 토큰에
  AI Gateway 권한을 추가해야 한다 (별도 판단 — 이 트랙에서 토큰 변경 없음).

## 과금 — Unified billing은 건드리지 않았다

게이트웨이 경유 Workers AI 호출은 기본적으로 기존 Workers AI 과금과 동일하다.
"Unified billing"(선불 AI Gateway 크레딧으로 Workers AI 결제)은 게이트웨이별
대시보드 설정으로, 이 트랙에서 변경하지 않았다. 선불 크레딧 결제로 바꾸려면
대시보드에서 해당 게이트웨이의 Workers AI billing 설정을 바꿔야 하며,
카드·선불 충전이 필요하면 사용자 원칙에 따라 중단한다.

## 이동하지 않은 경로 (별도 판단 사항)

- 외부 프로바이더 직접 호출 — `callGemini`·`callGroq`·`callNVIDIA`
  (`src/services/ai.ts`): 키 관리·ZDR 등 보안 경계와 맞물려 있어 이동 금지.
  AI Gateway 외부 프로바이더 라우팅으로 옮길지는 별도 판단.
- `WorkersAIAdapter` OpenAI 호환 REST 경로
  (`api.cloudflare.com/client/v4/accounts/.../ai/v1/chat/completions`):
  `env.AI.run`이 아니라서 옵션 적용 불가. 게이트웨이 URL 경유는 별도 판단.

## 도입 후 지연 전후 비교 방법 (라이브 검증 시)

`ai_usage` 원장(`provider, model, capability, latency_ms, input_tokens,
output_tokens, outcome, created_at`; outcome ∈ `success|rate_limited|failed`)의
`latency_ms` 분포를 배포 시점 T 전후로 비교한다. D1(SQLite)에는 백분위 함수가
없으므로 평균·최대·1초 이내 비중·성공률로 본다.

```sql
-- 배포 시점 T(ISO 시각, KST→UTC 변환 주의) 전후 7일, provider·model별 비교
-- D1 콘솔 또는 wrangler d1 execute --remote --command 로 실행
SELECT provider, model,
  CASE WHEN created_at < '<T>' THEN 'before' ELSE 'after' END AS period,
  COUNT(*) AS n,
  ROUND(AVG(latency_ms), 1) AS avg_ms,
  MIN(latency_ms) AS min_ms,
  MAX(latency_ms) AS max_ms,
  ROUND(SUM(CASE WHEN latency_ms < 1000 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) AS share_under_1s,
  ROUND(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) AS success_rate
FROM ai_usage
WHERE created_at >= datetime('<T>', '-7 days')
  AND created_at < datetime('<T>', '+7 days')
GROUP BY provider, model, period
ORDER BY provider, model, period;
```

해석 시 주의:

- `ai_usage`에는 게이트웨이 캐시 히트 여부 컬럼이 없다. 캐시된 요청은 지연이
  짧게 찍히므로, 전후 비교는 게이트웨이 대시보드 Analytics(캐시 히트율·지연)와
  함께 봐야 한다. 게이트웨이 경유 자체가 지연을 늘리면 평균·1초 이내 비중이
  p95보다 먼저 움직인다.
- 대조군: 외부 프로바이더(Gemini·Groq·NVIDIA)는 호출 경로가 바뀌지 않으므로
  같은 기간의 지연 분포를 대조군으로 삼을 수 있다. Workers AI만 나빠지면
  게이트웨이 경유 탓, 전부 나빠지면 네트워크·모델 측 문제로 본다.
- 배포 직후 샘플이 적으면(특히 음성·Clef) 7일이 아니라 14일로 창을 넓힌다.
- 게이트웨이 대시보드에서 `default` 게이트웨이가 자동 생성됐는지, 로그가
  쌓이는지 확인한다 (대시보드: AI Gateway → default → Logs/Analytics).

## 라이브 검증 대기 항목 (이 트랙에서 수행하지 않음)

- OTP 라이브 호출 금지 조건에 따라 라이브 호출 검증 없음.
- 배포 후 확인할 것: `default` 게이트웨이 자동 생성 여부, 게이트웨이 로그 적재,
  `ai_usage` 지연 분포 전후 비교 (위 SQL), 캐시 동작 (동일 질의 반복 시
  게이트웨이 캐시 히트 여부 — 채팅은 메시지 이력이 달라 히트율이 낮을 수 있음).
- 실패 시 롤백: `AI_GATEWAY_OPTIONS` 참조를 제거하면 게이트웨이 경유 전 상태로
  돌아간다 (코드 1곳 + 호출처 6곳).
