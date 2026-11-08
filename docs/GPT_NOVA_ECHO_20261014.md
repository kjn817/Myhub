# GPT 자문 요청: 노바 NVIDIA API 실패 원인 + 에코 복구 확인

## 배경
- 2026-10-14 14:48 KST 브라우저 QA에서 노바(builder, NVIDIA poolside/laguna-xs-2.1) 호출 3회 연속 실패
- 오류 메시지: "AI 호출 실패. 잠시 후 다시 시도해주세요."
- Muse가 "NVIDIA API 외부 장애"라고 단정했으나 측정 근거 없었음을 정정함

## 실측 결과 (2026-10-14 15:40 KST)

### NVIDIA 엔드포인트 상태
- 2026년 10월 build.nvidia.com API 장애 공개 보고 없음
- 직접 도달성 테스트: `curl https://integrate.api.nvidia.com/v1/models`
  - 키 없이 → HTTP 200
  - bogus 키 → HTTP 403
  - 결론: 엔드포인트·인증 검증 계층 정상 동작

### 코드 회귀 검증
- `src/services/ai.ts` callNVIDIA(): P1에서 `tools`/`tool_choice` 파라미터 추가
- 하지만 `if (tools && tools.length > 0)` 조건으로 일반 채팅 호출은 P1 이전과 바이트 단위 동일
- 결론: P1 코드 변경이 원인일 가능성 기각

### 미확인 (D1 쿼리 필요)
- `ai_error_log` 테이블의 nvidia provider 행 8건의 `http_status` 확인 필요
- 백그라운드 제약으로 쿼리 실행 못함, 다음 세션에서 확인 예정

## 가능한 원인별 대응

| http_status | 의미 | 대응 |
|-------------|------|------|
| 401 | 키 무효/만료 | 사용자가 Cloudflare Secrets에 NVIDIA 키 3개 직접 재발급·재등록 (Muse는 키 값 조회 불가) |
| 429 | 무료 티어 한도 초과 (40 RPM / 일 1만) | 사용량 확인 후 대기 또는 티어 상향 |
| 400 | 요청 포맷 문제 | 코드 수정 필요 |
| 5xx | NVIDIA 측 실제 문제 | 대기 후 재시도 |

## 에코 (Workers AI) 복구 상태

- 원인: 4006 일일 뉴런 할당량 소진 (2026-10-14 11:09 KST 확인)
- 공식 문서: "All limits reset daily at 00:00 UTC"
- **복구 시각: 2026-10-15 (목) 09:00 KST**
- 주의: 오늘 대시보드가 990/10k 표시 vs 실제 4006으로 lagging했음. 리셋 시각에도 대시보드가 아닌 실제 호출로 확인 필요 (stuck-quota 커뮤니티 보고와 일치)
- 일회성 자동 확인 크론 `echo-quota-recovery-check` 예약됨:
  - runonce @ 2026-10-15 09:30 KST
  - `@cf/meta/llama-3.2-1b-instruct` 최소 호출 1회
  - 200이면 "복구됨" / 4006이면 "stuck" 보고 후 종료

## GPT에게 묻고 싶은 것

1. **노바 원인 진단**: 위 실측 결과로 볼 때 401(키 문제) vs 429(한도) vs 5xx(서버 문제) 중 어느 쪽이 가장 유력한가? 추가로 확인할 지표가 있는가?

2. **대응 우선순위**: D1 쿼리 전에 사용자가 미리 준비할 수 있는 것은 무엇인가? (예: NVIDIA 키 상태 확인 방법)

3. **에코 크론**: 09:30 자동 확인을 유지하는 게 나은가, 사용자가 아침에 직접 테스트하는 게 나은가? stuck-quota 가능성을 고려할 때 자동 확인의 가치는?

4. **노바 폴백**: NVIDIA가 장기간 불안정하면 노바를 다른 프로바이더로 임시 전환하는 게 나은가? (현재 providerPin으로 nvidia 고정됨)
