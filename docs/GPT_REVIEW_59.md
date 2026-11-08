# MyHub 59차 기술 자문 요청 (GPT용) — Function Calling 한글 문제

## 1. 진행 상황

58차 권고에 따라 Traditional Function Calling을 구현했습니다.

**구현 완료:**
- `src/ai/memo-fc-tools.ts`: memo_create/search/get/update/delete 도구 정의
- `src/ai/memo-tool-dispatcher.ts`: 검증·실행·보안 검사 디스패처
- `src/services/ai.ts`: keeper+workers-ai일 때 Function Calling 활성화
- keeper 프롬프트를 마커 방식에서 Function Calling 안내로 업데이트

**1단계 실증 결과:**
- ✅ Workers AI가 `tool_calls`를 정상 반환
- ✅ 메모가 실제로 생성됨 (ID 167, 168)
- ✅ 텍스트 마커 없이 자연스러운 응답
- ✅ 영문 메모는 정확히 저장됨 (ID 168: "English test memo")

## 2. 문제: 한글 깨짐

**증상:**
- 요청: "Function Calling 테스트입니다"
- 저장: "Function Calling 테트네 주린댐는들른다"

**분석:**
- 영문("Function Calling ")은 정상
- 한글만 깨짐 ("테스트입니다" → "테트네 주린댐는들른다")
- 문자 코드 분석 결과, 단순 UTF-8 인코딩 문제가 아님
- 각 한글이 완전히 다른 한글로 교체됨 (예: 스→트, 입→주린)
- 모델이 tool_call 인자 내에서 한글을 잘못 생성하는 것으로 추정

**시도한 해결책:**
- 시스템 프롬프트에 "도구 인자의 한글은 정확하게 입력해. 깨지지 않도록 주의해." 추가
- NFC 정규화 적용
- 효과 미확인 (배포 후 테스트 대기 중)

## 3. 질문

1. Llama 3.3 70B가 Function Calling의 JSON 인자 내에서 한글을 잘못 생성하는 것은 알려진 문제인가?
2. 프롬프트 개선 외에 해결 방법이 있는가? (예: tool 정의에 한글 예제 추가, temperature 조정 등)
3. 만약 모델의 근본적 한계라면, 대안은 무엇인가?
   - JSON Mode 사용 (58차에서 대안으로 언급됨)
   - 한글을 피하고 영문으로 처리 후 변환
   - 다른 접근법
4. Cloudflare Workers AI에서 한글 Function Calling을 성공적으로 사용한 사례가 있는가?

## 4. 제약 조건

- Workers AI 유지 필수 (사용자 요구)
- 한국어 서비스이므로 한글 지원은 필수
- 운영 중인 서비스이므로 안정성 중요
