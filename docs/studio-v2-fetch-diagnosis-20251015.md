# Studio v2 "Failed to fetch" 진단 (작성: 2026-10-15 20:40 KST)

## 증상
- 2026-10-15 10:47 UTC E2E 테스트2: v2 수정 요청 → 브라우저에 "Failed to fetch" 네트워크 오류, 버전 기록에 v2 없음.
- 동일 시그니처 선행 측정: NVIDIA 모델 테스트에서 요청 약 60~90초 후 "Failed to fetch" (memory/2026-10-15.md:498).
- 대조군: 빠른 Gemini 생성(5파일 투두 앱)은 성공 (memory/2026-10-15.md:582).
- 패턴: 빠른 요청은 성공, 느린 요청은 전송 계층에서 사망.

## 원인 (코드 근거 — 추측 아님)
1. **동기 직접 모드**: `POST /api/artifact/jobs`가 `processArtifactJob()` 전체를 `await`한 뒤에야 응답한다
   (`src/modules/artifact/routes.ts:460-468`). 에이전트가 도는 수 분 동안 응답 바이트가 0인 채 연결이 유휴 상태.
2. **에이전트에 전체 시간 예산 없음**: 최대 10턴 × 턴당 `AbortSignal.timeout(120000)` = 최악 수십 분
   (`src/services/studio-agent.ts:141,214,370-397`). 턴당 타임아웃은 있어도 루프 전체 예산은 없다.
3. **유휴 연결이 중간에 끊김** → 브라우저 `fetch()`가 `TypeError: Failed to fetch`를 throw.
   앱 오류였다면 JSON 500 응답이 오지 throw가 발생하지 않는다. 즉 원인은 전송 계층 kill.
   (정확히 어느 홉에서 끊는지는 미확인 — NAT/프록시/엣지 유휴 타임아웃이 유력. 수정안은 홉과 무관하게 유효.)
4. **부차 버그 (v2 파일 저장 누락)**: modify 경로는 새 버전의 `artifact_files`에 에이전트 멀티파일을 저장하지 않는다.
   - `processArtifactJob` 인라인 저장 분기 (`job-processor.ts:180-230`): create 분기에만 `saveWorkspaceToD1` 호출.
   - `saveJobResult` modify 분기 (`job-processor.ts:354-381`): 주석으로 "이 부분은 호출자에서 처리하거나"라며 미구현.
   - 전송 문제가 해결돼도 v2의 파일 트리/diff UI는 비게 된다.

## 수정안 (내일 작업용 — 오늘 밤 코드 변경/배포 없음)
1. `POST /api/artifact/jobs`: job 행 INSERT → `env.ARTIFACT_QUEUE.send({ jobId })` → `202 { ok: true, jobId }` 즉시 반환.
   `status` 필드를 빼면 프론트의 기존 폴링 경로(`public/agent.html:741-763`, 2.5초 간격 `GET /jobs/:id`)가 자동 활성화된다.
2. Queue Consumer가 `processArtifactJob` 처리 — 이미 연결돼 있음 (`src/index.ts:232-255`, 15분 예산, lease/claim·멱등성 보유).
   `wrangler.toml:33-38` 바인딩 `myhub-artifact-jobs` 확인됨.
3. 에이전트 루프에 전체 wall-clock 예산 추가 (예: 8분, 큐 15분 이내). 초과 시 JSON 오류 반환 — 전송 kill 대신 정상 실패 응답.
4. modify 버전 저장 시에도 `saveWorkspaceToD1(env.DB, newVersionId, agentFiles)` 호출 (두 저장 경로 모두).

## 검증 계획 (내일)
- [ ] v2 수정 요청 시 POST가 즉시 202 + jobId 반환하는지 (DevTools)
- [ ] 폴링으로 done까지 도달하는지, 3분 이상 장기 작업에서도 "Failed to fetch"가 없는지
- [ ] 버전 기록에 v2 생성 + 파일 트리/diff 표시 확인
- [ ] Queue 경로 E2E (이전 "running에 갇힘" 증상 재발 여부)

## 참고
- 직접 모드 도입 이유(`routes.ts:454-456`): "Workflow의 waitUntil 30초 제한으로 장시간 작업 불가" — Workflow가 아닌
  Queue Consumer는 15분 예산이라 이 제약과 무관하다. 원래 설계(큐)가 맞는 길이었다.
- Cloudflare 커넥터 401 관련: 11:38 KST 직접 호출 200 OK 확인됨 — 토큰 정상. 사용자에게 재연결 요구 금지.
