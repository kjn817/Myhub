# GPT 자문 요청: AI 스튜디오 524 타임아웃 (채팅은 정상)

## 테스트 결과 (2026-10-15 00:13 KST)

| 경로 | 결과 |
|------|------|
| 채팅 (@노바 "안녕?") | ✅ 정상 응답: "안녕하세요, 김정남님..." |
| 스튜디오 ("계산기") | ❌ 524 타임아웃 (3분 대기 후 실패) |

**결론: NVIDIA 정상, 우리 시스템(스튜디오) 문제**

## 현재 스튜디오 코드 (src/modules/artifact/generate-html.ts)

P0-2로 새로 만든 전용 경로. 채팅 파이프라인을 우회하고 NVIDIA에 직접 호출.

주요 특징:
- D1 `job_provider_attempts`에 원자적 예약 (UNIQUE(job_id))
- `max_tokens: 8192`, `temperature: 0.1`
- `AbortSignal.timeout(180000)` (3분)
- 시스템 프롬프트: HTML 생성 지시 (약 2000자)
- 사용자 프롬프트: "계산기" + 컨텍스트

## 질문

1. **왜 채팅은 되고 스튜디오는 타임아웃인가?**
   - 채팅: 짧은 프롬프트 ("안녕?"), 빠른 응답
   - 스튜디오: 긴 시스템 프롬프트 (HTML 생성 지시) + `max_tokens: 8192`
   - 가설: 프롬프트가 너무 길거나, max_tokens가 너무 높아서 NVIDIA가 시간 초과?

2. **코드 문제점?**
   - `generateArtifactHtml()`의 fetch 로직에 버그가 있는가?
   - D1 예약이 블로킹하는가?
   - 키 선택 로직 (`keys[0]` 고정)이 문제인가?

3. **권장 수정:**
   - max_tokens를 낮춰야 하는가? (8192 → 4096?)
   - 시스템 프롬프트를 짧게 해야 하는가?
   - 스트리밍을 사용해야 하는가?
   - 타임아웃을 더 늘려야 하는가? (180초 → ?)

## 참고: 채팅 경로 (정상 동작)

`callSingleAssistant` → `aiChat` → `selectModel` → `callNVIDIA`
- `max_tokens: 4096` (generate-html.ts의 절반)
- 동일한 NVIDIA 엔드포인트
- 동일한 키

차이점: 프롬프트 길이, max_tokens, 호출 경로
