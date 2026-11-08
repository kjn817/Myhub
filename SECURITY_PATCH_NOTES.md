# 운영 최소 보안 패치 — 변경 파일 명세

## 포함 파일 (4개)

### 1. src/ai/legacy-privacy-guard.ts (신규)
- `resolvePolicySensitivity()`: 민감도 최댓값 결정
- `resolveRequestSensitivity()`: 비서별 민감도 결정
- `checkProviderAllowed()`: ModelRouter 정책 검사
- `checkDataPolicy()`: 데이터 정책만 검사 (private용)
- `getPersonaMinSensitivity()`: keeper/scheduler → personal
- `getLegacyMarkerTools()`: 서버 도구 정책
- `PrivacyBlockedError`: 차단 예외
- `rankSensitivity()`, `maxSensitivityLevel()`: 비교 헬퍼

### 2. src/services/ai.ts (수정)
- `TaskPolicy.sensitivity?`, `TaskPolicy.personaId?` 필드 추가
- `selectModel()`: 민감도 기반 Provider 필터링
  - Gemini 체인, 오버라이드 모두 정책 검사
  - 허용 Provider 없음 → PrivacyBlockedError
- `aiChat()`: 실제 호출 직전 재검사

### 3. src/modules/ai/routes.ts (수정)
- `callSingleAssistant()`: `policy.personaId` 설정, `policy.sensitivity` 결정
- `/chat`: `PrivacyBlockedError` → 403 안내 응답

### 4. src/ai/model-router.ts (수정)
- `canUseProvider()`에 `skipStatusCheck` 옵션 추가
- workers-ai `allowRestricted`: true → false

## 제외 (명시적)
- src/ai/prompt-integration.ts (Phase 3D)
- src/ai/eval-runner.ts (Phase 3D)
- migrations/0025_prompt_version.sql (Phase 3D)
- ai.prompt_v2 플래그 로직
- prompt_version 저장 로직
- 캘리 Function Calling

## 의존성
- model-router.ts는 기존 파일 (수정만, 신규 의존성 없음)
- legacy-privacy-guard.ts는 model-router.ts만 import

## 테스트
- 515개 전체 통과
- 30개 프라이버시 테스트 통과 (S0.1, S0.2 포함)
- TypeScript 0 errors
