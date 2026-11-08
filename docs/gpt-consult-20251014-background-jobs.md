# GPT 자문 요청: Cloudflare Workers 백그라운드 작업이 멈추는 문제

## 상황
MyHub의 AI 스튜디오에서 노바(AI)가 앱을 만드는 작업을 백그라운드에서 실행하려고 함.
사용자가 페이지를 떠나도(홈으로 이동, 새로고침, 브라우저 종료) 작업이 계속 실행되어야 함.

## 구현한 방식
1. `POST /api/artifact/jobs` → D1 `artifact_jobs` 테이블에 작업 생성 (status='pending')
2. `c.executionCtx.waitUntil(processJob(env, jobId))` 로 백그라운드 실행
3. `processJob`이 `callSingleAssistant(env, 'builder', messages)` 로 AI 호출 (최대 5회 재시도)
4. 완료되면 아티팩트/버전을 D1에 직접 생성하고 status='done'
5. 프론트엔드는 `GET /api/artifact/jobs/:id` 로 폴링

## 실제 문제
D1을 조회해보니 모든 작업이 `status='running', attempts=1` 에서 멈춰있음.
- 4개의 작업이 각각 다른 시간에 생성됨 (09:22, 09:27, 09:30, 09:30)
- 모두 첫 번째 시도에서 멈춤. 완료도 실패도 안 됨.
- `updated_at`이 생성 시간과 동일하거나 1초 차이 → 첫 `callSingleAssistant` 호출에서 hang

## processJob 핵심 코드
```typescript
async function processJob(env: Env, jobId: number) {
  const maxTries = 5
  try {
    await env.DB.prepare(`UPDATE artifact_jobs SET status='running'...`).bind(jobId).run()
    const job = await env.DB.prepare('SELECT * FROM artifact_jobs WHERE id=?').bind(jobId).first()
    // ...
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        await env.DB.prepare(`UPDATE artifact_jobs SET attempts=?...`).bind(attempt, jobId).run()
        const result = await callSingleAssistant(env, 'builder', [{ role: 'user', content: sysCtx }])
        // ... HTML 파싱 ...
        if (html) break
      } catch (e) {
        lastErr = e.message || '호출 오류'
      }
      if (attempt < maxTries) await new Promise(r => setTimeout(r, 1500 * attempt))
    }
    // ... 결과 저장 ...
  } catch (e) {
    await env.DB.prepare(`UPDATE artifact_jobs SET status='failed'...`).bind(...).run()
  }
}
```

## callSingleAssistant 개요
- `src/modules/ai/routes.ts`에 정의
- personaId='builder'로 AI 호출 (외부 API: NVIDIA, Gemini 등)
- 내부적으로 `aiChat()` 호출 → 프로바이더 API fetch
- 타임아웃 설정이 명시적으로 있는지 불확실

## 질문
1. `waitUntil`에서 `callSingleAssistant` 같은 외부 API 호출이 hang하는 원인은?
2. `waitUntil`의 실행 시간 제한이 문제인가? (30초 제한?)
3. hang된 promise를 감지하고 타임아웃 처리하는 best practice는?
4. Cloudflare Workers에서 장시간 백그라운드 작업을 안정적으로 실행하는 권장 패턴은?
   - Durable Objects를 써야 하는가?
   - 아니면 Queue를 써야 하는가?
5. 현재 구조에서 최소 변경으로 hang을 방지하는 방법은?

## 환경
- Cloudflare Workers (free tier)
- D1 데이터베이스
- AI 프로바이더: NVIDIA (poolside/laguna-xs-2.1), Gemini 등 외부 API
