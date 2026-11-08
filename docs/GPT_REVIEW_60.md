# MyHub 60차 기술 자문 요청 (GPT용) — 원문 참조형 도구 설계 검토

## 1. 배경

59차 자문에서 권장한 A/B/C/D 경계 추적을 시도했습니다.

**60차-1 조사 결과:**
- `env.AI.run()` 직접 호출, 스트리밍 미사용, 중간 SDK 없음
- 알려진 #2482 스트리밍 버그는 해당 안 됨
- MyHub 파싱 경로(JSON.parse, NFC 정규화, 메시지 구성)는 한글을 변형시킬 수 없는 구조
- 변형은 B 지점(Workers AI 모델 생성 또는 응답 계층)에서 발생했을 가능성이 가장 높음

**제약:**
- API 토큰에 Workers AI 권한이 없어 VM에서 B를 직접 테스트 불가
- 기존 D1 로그에는 args_hash만 저장되어 원본 복원 불가
- B의 원본 증거 확보에는 디버그 배포가 필요

## 2. Muse의 제안: 원문 참조형 구조

원인 확정과 무관하게 구조적으로 문제를 제거하는 방향을 제안합니다.

**핵심 아이디어:**
모델이 메모 본문을 토큰으로 재생성하지 않고, 사용자의 원본 메시지 중 저장할 범위를 지정하면 서버가 원문을 그대로 추출해 저장합니다.

### 설계안 v1

**도구 정의 변경:**

```typescript
{
  name: 'memo_create_from_source',
  description: 'Create a memo from the user\'s original message. Use when the user dictates memo content directly.',
  parameters: {
    type: 'object',
    properties: {
      // 참조할 사용자 메시지 (기본값: 마지막 사용자 메시지)
      message_index: {
        type: 'number',
        description: 'Index of the user message to extract from (0 = last user message)',
      },
      // 추출 범위 (문자 단위)
      start: {
        type: 'number',
        description: 'Start character index in the original message',
      },
      end: {
        type: 'number',
        description: 'End character index (exclusive)',
      },
    },
    required: ['start', 'end'],
  },
}
```

**서버 처리:**
1. 인증된 사용자의 메시지인지 확인
2. 서버에 보존된 원본 텍스트에서 [start, end) 범위 추출
3. 범위 유효성 검증 (0 <= start < end <= 원문 길이)
4. 추출된 원문을 그대로 `executeMemoCreate`에 전달
5. 기존 잠금·권한 검사 유지

**예시:**
- 사용자: "메모 만들어줘. 내용은 '한글 테스트입니다'로 해줘"
- 모델: `memo_create_from_source({start: 15, end: 24})`
- 서버: 원문[15:24] = "한글 테스트입니다" 추출 → 저장

### 기존 memo_create와의 관계

| 요청 유형 | 사용할 도구 | 이유 |
|----------|------------|------|
| 사용자가 직접 내용을 말함 | memo_create_from_source | 원문 보존, 변형 불가 |
| 요약·재작성 요청 | memo_create (기존) | 모델이 새 문장 생성 필요 |
| AI 생성 초안 | 확인 후 저장 (별도 경로) | 사용자 검증 필요 |

## 3. GPT에게 질문

### Q1. 인덱스 방식의 신뢰성

모델이 한글 텍스트의 정확한 문자 인덱스를 계산할 수 있는가?
- 한글은 자모가 결합된 형태라 모델의 인덱스 계산이 부정확할 가능성이 있음
- 대안: 모델이 추출할 부분 문자열의 앞뒤 "앵커"를 지정하고 서버가 검색하는 방식
- 예: `{anchor_start: "내용은 '", anchor_end: "'로 해줘"}` → 서버가 원문에서 앵커 사이를 추출

어느 방식이 더 신뢰할 수 있는가?

### Q2. 범위 지정이 모호한 경우

사용자: "메모 만들어줘"
모델이 범위를 특정할 수 없을 때:
- (a) 도구 호출하지 않고 "어떤 내용으로 만들까요?" 질문
- (b) 전체 마지막 메시지를 저장 (지시문까지 포함될 위험)
- (c) 별도 확인 절차

권장하는 폴백은?

### Q3. 보안 경계

원문 참조형에서 추가로 고려할 보안 사항:
- 메시지 소유권: 다른 사용자의 메시지를 참조할 수 없도록 세션 기준으로 격리 (이미 aiChat이 인증된 세션에서 동작)
- 인젝션: 원문에 악성 스크립트가 포함된 경우 → 기존 memo-tools의 sanitize가 처리하는지 확인 필요
- 범위 조작: 모델이 의도적으로 지시문을 포함하는 범위를 지정하면? → 서버에서 명령문 패턴 검증 필요?

### Q4. 기존 도구와의 공존

`memo_create` (모델 생성형)와 `memo_create_from_source` (원문 참조형)를 둘 다 유지하는 것이 나은가,
아니면 `memo_create`에 `source_ref` 옵션을 추가하는 것이 나은가?

### Q5. 점진적 전환 전략

현재 운영에 배포된 `memo_create`를 즉시 교체하는 것이 아니라:
1. `memo_create_from_source` 추가 (기존 유지)
2. 프롬프트에서 직접 받아쓰기는 새 도구 사용하도록 안내
3. 안정성 확인 후 기존 도구 deprecate

이 전략에 대한 의견은?

## 4. 제약 조건

- Workers AI 유지 필수
- 운영 배포는 별도 승인 전까지 금지
- 정규식·하드코딩·땜빵식 예외 추가 금지
- 잠긴 메모는 검색·저장 모든 경로에서 제외
- AI는 잠금·해제 기능 절대 불가
