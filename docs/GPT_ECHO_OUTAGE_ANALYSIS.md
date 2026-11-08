# GPT 자문 요청 — MyHub 에코(keeper) 백엔드 전체 장애 근본원인 분석

**작성일:** 2026-10-14
**작성자:** Muse (사용자 요청)
**긴급도:** P0 (에코 전체 불능)

---

## 1. 증상

2026-10-14 11:09 KST부터 에코(keeper) 위젯이 모든 요청에 대해 다음을 반환:
- "죄송해요, 응답을 받지 못했어요."

영향 범위:
- 기본 대화 ("안녕") → 실패
- 메모 생성 → 실패
- 메모 요약 → 실패
- 메모 열기 → 실패
- 배치 열기 → 실패

프론트엔드는 정상 (메모 목록 50개 로드, 위젯 UI 동작, 메시지 전송 가능).
`/api/health` → 200 OK.
문제는 `/api/ai/chat` API가 `ok: true` + `text`를 반환하지 않는 것.

## 2. 타임라인

| 시각 (KST) | 차수 | 내용 | 결과 |
|-----------|------|------|------|
| 10:34 | 84차 초판 | 배치 열기 (open_search 액션 추가, 도구 스키마 변경) | 배포 후 QA에서 심각한 회귀 발견 |
| 10:39 | - | 84차 초판 QA | 생성 실패, 요약 실패, 삭제 오동작, 도구 JSON 노출 |
| 10:44 | - | 84차 초판 롤백 → 83차로 복원 | - |
| 10:45 | 84차(재) | 배치 열기 (스키마 변경 없이 서버 패턴 감지) | 커밋만, 배포 실패 |
| 10:54 | 85차 | deploy_full.py 검증 로직 수정 (urllib→curl 폴백) | 배포 검증 실패 지속 |
| 11:04 | - | GPT 자문 (배포 검증 실패 원인) | urllib chunked 문제 확정 |
| 11:07 | 85차 | 모든 검증에 curl 폴백 적용 | **배포 성공** (9/9 PASS) |
| 11:09 | - | 85차 QA | **에코 전체 장애 발견** |
| 11:12 | 86차 | 84차(재) 롤백 (83차 코드로 복원) | 배포 성공, **장애 지속** |

**핵심:** 86차는 83차 코드인데도 장애가 지속됨. 83차는 이전에 동작했음 (2026-10-13 QA에서 생성/요약/닫기 PASS).

## 3. 84차(재)의 변경 내용 (롤백됨)

### 3.1 `src/ai/memo-tool-dispatcher.ts`

`executeMemoUiAction()` 함수에 배치 열기 로직 추가:

```typescript
// 84차(재): "모두 열어줘" 패턴은 배치 처리
if (typeof memoId !== 'number' && action !== 'close') {
  // 배치 열기 감지: 원본 메시지에서 "모두 열어줘" 패턴 확인
  const origMsgs = ctx?.originalMessages || []
  const lastUserMsg = [...origMsgs].reverse().find((m: any) => m.role === 'user')
  const userText = String(lastUserMsg?.content || '')
  const isBatchOpen = action === 'open' && (userText.includes('모두 열어') || userText.includes('모두 보여'))

  if (isBatchOpen) {
    let query = ''
    const match = userText.match(/(.+?)\s*(포함된|관련|들어간)?\s*메모\s*모두\s*(열어|보여)/)
    if (match && match[1]) {
      query = match[1].trim().replace(/^(이|그|저)\s+/, '')
    }
    if (query) {
      try {
        const results = await env.DB.prepare(
          `SELECT id FROM memos WHERE is_locked = 0 AND text LIKE ? ORDER BY id DESC LIMIT 5`
        ).bind(`%${query}%`).all() as any
        const ids = (results?.results || []).map((r: any) => r.id).filter((id: any) => typeof id === 'number')
        if (ids.length > 0) {
          return {
            success: true,
            data: {
              uiAction: 'open_memo_batch',
              memoIds: ids,
              count: ids.length,
              status: 'ui_pending',
              message: `${ids.length}개의 메모 열기 요청을 전달했습니다.`,
            },
          }
        }
      } catch { /* 폴백 */ }
    }
    return { success: false, error: '배치 열기 대상을 찾지 못했습니다' }
  }
  // ... 기존 Memo Target Resolver 로직
}
```

### 3.2 `src/services/ai.ts`

UI 액션 수집 로직 변경:

```typescript
// 변경 전:
const uiActions = results
  .filter((r: any) => r.success && r.data && r.data.uiAction)
  .map((r: any) => ({
    uiAction: r.data.uiAction,
    memoId: r.data.memoId,
  }))

// 변경 후 (84차 재):
const uiActions: Array<any> = []
for (const r of results) {
  const rd: any = r
  if (!rd.success || !rd.data || !rd.data.uiAction) continue
  if (rd.data.uiAction === 'open_memo_batch' && Array.isArray(rd.data.memoIds)) {
    for (const id of rd.data.memoIds) {
      uiActions.push({ uiAction: 'open_memo', memoId: id })
    }
  } else {
    uiActions.push({ uiAction: rd.data.uiAction, memoId: rd.data.memoId })
  }
}
```

프롬프트에 한 줄 추가:
```
'예: "테스트 포함된 메모 모두 열어줘" → memo_ui_action(action: "open") 호출. 서버가 "모두 열어줘"를 감지해 배치로 처리함. ' +
```

## 4. 현재 상태 (86차)

- 코드: 83차와 동일 (`src/ai/memo-tool-dispatcher.ts`, `src/services/ai.ts`가 83차 상태)
- 배포 스크립트: 85차 (curl 폴백 포함, 정상 동작)
- 배포: 성공 (9/9 검증 PASS, 100% 트래픽)
- 증상: 에코 전체 장애 지속

## 5. 에코(keeper)의 AI 모델 구성

`src/modules/ai/routes.ts:97`:
```typescript
keeper: 'workers-ai',
```

`src/services/ai.ts:112` (MODELS 정의):
```typescript
{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'workers-ai', quality: 'high', status: 'active' },
```

모델 선택 흐름 (`selectModel`):
1. `PERSONA_POLICY.keeper.capability` = `'summarize'`
2. `PERSONA_PROVIDER.keeper` = `'workers-ai'` → `policy.providerPin` 설정
3. D1 오버라이드 조회: `model.summarize` = `'@cf/meta/llama-3.3-70b-instruct-fp8-fast'`
4. `scopedModels`에서 해당 ID 검색 → `status: 'active'` 확인 → 반환

D1 `ai_settings`:
- `ai.prompt_v2.keeper: true`
- `model.summarize: @cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `model.chat: gemini-3.5-flash-lite` (keeper는 workers-ai 고정이므로 미사용)

MEMORY.md 기록 (2026-10-13):
- "에코=workers-ai(@cf/meta/llama-3.3-70b-instruct-fp8-fast)"
- "매핑·운영 실측 ✅" (당시에는 동작했음)

## 6. 진단 결과

### 6.1 확인된 사실
- Worker 프로세스 정상 (`/api/health` 200)
- D1 연결 정상 (AI 설정 조회 가능)
- 배포 검증 9/9 PASS
- 프론트엔드 정상 (메모 목록, 위젯 UI)
- `/api/ai/chat`이 `ok:true` + `text`를 반환하지 않음

### 6.2 배제된 원인
- 84차(재) 코드 버그 → 86차에서 롤백했으나 장애 지속
- 배포 스크립트 문제 → 85차에서 수정, 배포 성공
- 네트워크 문제 → health check 정상

### 6.3 미확인 원인
- Workers AI 바인딩 장애
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 모델 deprecated 또는 이름 변경
- Workers AI 할당량 초과
- Cloudflare 계정 문제
- D1의 모델 설정이 실제 코드와 불일치

## 7. GPT에게 요청하는 분석

1. **근본원인 특정:** 83차 코드가 10-13에는 동작하고 10-14에는 동작하지 않는 이유는? 코드가 동일하다면 환경/외부 요인이어야 함. 가장 유력한 후보는?

2. **Workers AI 진단:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 모델의 현재 상태는? Cloudflare가 2026-10-14 전후에 해당 모델을 변경/제거했는가? 대체 모델은?

3. **코드 검증:** 84차(재)의 변경이 Workers AI 호출에 영향을 줄 수 있는가? 특히 `ctx?.originalMessages` 접근이나 정규식 `userText.match()`가 예외를 유발할 수 있는가? (롤백 후에도 장애가 지속되므로 직접 원인은 아닐 것으로 보이지만, 확인 필요)

4. **D1 설정 정합성:** `model.summarize`와 keeper의 실제 사용 모델이 일치하는가? 코드에서 keeper의 모델명을 결정하는 로직을 추적해줘.

5. **복구 방안:** 
   - Workers AI 문제라면: 대체 모델 또는 폴백 구성
   - 설정 문제라면: D1 수정 SQL
   - 코드 문제라면: 최소 수정 패치

6. **재발 방지:** 모델 장애 시 에코가 "응답을 받지 못했어요" 대신 명확한 오류를 반환하도록 하려면? Health check에 AI 모델 연결 상태를 포함해야 하는가?

## 8. 제약

- 운영 배포는 별도 승인 전까지 금지 (현재 86차가 운영 중)
- D1 운영 DB 수정은 명시적 승인 후 수행
- 추측성 수정 금지, 증거 기반 진단 필요
