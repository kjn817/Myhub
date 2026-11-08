# cloudflare/agents SDK POC — 캘리(스케줄러) (트랙 C1, 조사 문서 2-1절)

- 날짜: 2026-10-26 (KST)
- SDK: `agents@0.24.0` (MIT, pre-1.0) — 조사 결론대로 **POC까지만, 통째 이전 금지**
- 위치: `.scratch/agents-poc/` (운영 `src/` 미변경, 운영 번들 미포함)
- 검증: 로컬 miniflare 실런타임 테스트 (`test-poc.mjs`, 12개 검사 전수 PASS × 2회 실행)
- 배포·운영 D1 쓰기·OTP·실제 LLM 호출 없음. 비밀키 사용 없음.

## 결론 — 권고: POC 유지 (확대 보류, 중단 아님)

**지금은 POC 상태로 두고, 다음 단계(별도 스크래치 Worker에 올려 에지 실측) 결정은
사용자에게 맡긴다.** 근거:

- **되는 것은 확인됐다.** D1 대화 기록과 DO SQLite의 양립, 30초 제한의 우회 패턴,
  유휴 후 알람 복귀가 로컬에서 전부 동작한다 (수치는 아래).
- **아직 모르는 것이 크다.** 에지 하이버네이션 복귀 지연과 WebSocket 실시간 경로는
  로컬에서 재현이 안 돼 NOT TESTED다. 이 둘이야말로 Agents SDK 도입의 본질적
  가치(실시간 동기화·유휴 비용 0)라, 이를 재지 않고 확대 결정을 내릴 수 없다.
- **긴급성이 없다.** 지금 D1·KV에 손으로 구현된 상태·스케줄·승인이 동작하고 있다.
  이전의 대가는 pre-1.0 API 변동 리스크(0.24.0 고정 당시 최신은 이미 0.30.1)와
  2.5 MB 번들(미사용 이메일·MCP·음성 표면 포함)이다.
- **비용은 걸림돌이 아니다.** 아래 무료 한도 판정 참조 — POC와 단일 사용자 운영은
  무료 티어 안에서 충분히 돈다. 카드·결제가 필요 없어 중단 사유가 되지 않는다.

## 무료 / 유료 판정 — 무료 티어로 POC 가능 (카드 불필요)

공식 문서(developers.cloudflare.com/durable-objects/platform/pricing/, 업데이트
2026-10-18) 실측:

| 항목 | Workers Free 플랜 | 비고 |
|---|---|---|
| DO 요청 | 100,000 / 일 | HTTP·RPC·WebSocket 메시지·알람 포함 |
| DO 지속 시간 | 13,000 GB-s / 일 | 하이버네이션 중 과금 없음 |
| SQLite 행 읽기 | 5,000,000 / 일 | D1과 동일 한도 |
| SQLite 행 쓰기 | 100,000 / 일 | `setAlarm()`도 쓰기 1행으로 계산 |
| SQLite 저장 | 5 GB (총량) | |
| 무료 한도 초과 시 | **해당 연산이 에러로 실패** (초과 과금 없음) | 카드가 없어도 과금 사고가 안 나는 구조 |

판정:

- **Durable Objects는 Workers Paid($5/월) 전제가 아니다.** 조사 문서의 "DO는
  Workers Paid 전제"는 정정된다 — SQLite-backed DO는 Free 플랜에서 생성·접근
  가능하고, **KV-backed DO만 Paid 전용**이다. POC는 SQLite-backed만 쓴다.
- MyHub는 단일 사용자 서비스라 위 한도에 닿을 여지가 사실상 없다
  (POC 1회 실행의 DO 쓰기는 수십 행 수준).
- 단, 무료 플랜은 한도를 넘기면 실패이지 과금이 아니므로, 도입한다면 한도
  모니터링(요청·쓰기 행 수)을 대시보드에 붙이는 것이 안전장치가 된다.

## 측정 결과 (로컬 miniflare, 2026-10-26 2회 실행)

환경: Node v24.22.1, workerd 1.20261019.1, miniflare 5.20261019.2-beta,
esbuild(레포 내장), agents 0.24.0. D1은 miniflare 로컬 D1(운영 DB 아님).

| # | 검사 | 결과 (2회차 / 1회차) |
|---|---|---|
| (d) | 첫 요청 (workerd 기동 + DO 생성 + onStart 포함) | 148 ms / 144 ms, intent=chat |
| (d) | 온 요청 5회 중앙값 | 11 ms / 14 ms (범위 10–18 ms / 11–21 ms) |
| (a) | 일정 의도 파싱·D1 schedules 행 생성 | 83 ms / 54 ms, scheduleId=1, 제목 "팀 회의", start_at 2026-10-27T00:30:00.000Z (내일 09:30 KST) |
| (a) | D1 ai_chats ↔ DO poc_turns 일치 | **14행 = 14행, 내용 일치 (match=true)** |
| (a) | D1 schedules 행 조회 | 1행, 제목·시각·status=active 일치 |
| (a) | 일정 조회 의도 (D1 읽기) | "· 팀 회의 (2026-10-27T00:30:00.000Z)" 반환 |
| (b) | 단기 작업 인라인 (3스텝 × 1초) | elapsed 3005 ms, wall 3011 ms — 30초 안에 완료 |
| (b) | 장기 작업 defer (6초짜리를 예산 5초로) | **202 반환, wall 110 ms** — 요청은 즉시 반환 |
| (b) | 백그라운드 나머지 완료 | 완료 행(DO 전용 system 턴) 확인됨 |
| (a) | 최종 행 수 | D1 14행, DO 15행 (system 행 1개는 DO 전용 — 설계대로) |
| (c) | 9초 무요청 유휴 후 첫 요청 | **5 ms / 10 ms** (온 중앙값 11–14 ms와 차이 없음) |
| (c) | 알람 배달 (schedule 후 유휴 중) | 1건 배달됨, delivered_at 2026-10-26T08:40:35.006Z |

세부 판정:

- **(a) D1 양립: 가능.** DO는 휘발성 세션 상태·알림 스케줄러, D1은 대화·일정의
  원천(source of truth)으로 두면 된다. 이중 기록이 행 단위로 정확히 일치함을
  확인했다. DO SQLite가 날아가도 D1에서 복원 가능한 구조다.
- **(b) 30초 제한: 우회 가능.** 인라인 작업은 예산(28초) 안에서 실행하고,
  넘길 것으로 예상되면 `this.schedule()`로 백그라운드에 넘겨 202를 즉시 반환한다.
  단, 이 예산은 POC에서 테스트용으로 5초로 주입한 것이고, 플랫폼 제한 30초 자체를
  로컬에서 강제 재현하지는 못했다 (miniflare는 30초 제한을 강제하지 않는다).
- **(c) 하이버네이션 복귀: 로컬에서는 지연 없음.** 9초 유휴 후 요청이 5 ms로
  왔고 알람도 제시간에 배달됐다. 다만 miniflare는 DO를 메모리에서 쫓아내지
  않으므로 **에지 하이버네이션 복귀 지연은 측정되지 않았다 (NOT TESTED)**.

## POC 구조

```
.scratch/agents-poc/
  calli-agent.ts   CalliAgent extends Agent — onStart 스키마, onRequest 라우팅,
                   /message·/history·/schedules·/deliveries·/long-task·/health,
                   sendReminder / runLongTaskRemainder 알람 콜백,
                   결정적 한국어 의도 파서(스텁 LLM — 실제 모델 호출 없음)
  worker.ts        routeAgentRequest 진입점 (CalliAgent DO 바인딩 + DB 바인딩)
  test-poc.mjs     로컬 검증 스크립트 (12개 검사, 종료 코드 0/1)
```

재현: `node .scratch/agents-poc/test-poc.mjs` (레포 루트에서).
스크립트가 `agents@0.24.0`을 `/tmp/agents-poc-deps`에 격리 설치하고
(운영 package.json·node_modules 불변), esbuild로 번들링한 뒤 miniflare에 올린다.

설계상 단축 (문서에 남긴다):

- **알림 지연 5초 고정.** 실제 일정 시각이 60초보다 멀면 5초 뒤 "미리보기 알림"을
  울린다. 정확한 시각 알림은 같은 `this.schedule(Date)` API에 지연값만 바꾸면
  되므로 메커니즘 검증에는 영향이 없다.
- **LLM은 스텁.** 의도 파서는 정규식 기반 결정적 파서다. 실제 Groq 호출은 POC에
  비밀키를 넣지 않기 위해 연결하지 않았다. 도입 시 캘리=Groq 경로를 붙이는 것이
  별도 작업이다.
- **이메일 채널 스텁.** agents SDK가 모듈 최상위에서 `cloudflare:email`을
  import하는데, 이 모듈은 send_email 바인딩이 있는 Worker에서만 열린다.
  POC는 이메일을 쓰지 않으므로 번들 시 스텁으로 alias했다 (실배포 시 send_email
  바인딩을 달 것).

## 로컬 검증 중 발견한 함정 (재현 시 참고)

1. **miniflare v5 API 변경.** `new Miniflare({modules, script, ...})` v4 형태는
   더 이상 직접 안 받고 `convertV4MiniflareOptions({...})`로 변환해야 한다.
2. **scriptPath는 /tmp 경로와 상성이 나쁘다.** `/tmp` 번들을 `scriptPath`로 넘기면
   workerd VFS가 시작 디렉토리 밖의 `..`를 거부해 기동 크래시
   (`kj/filesystem.c++ ... can't use ".." to break out`)가 난다.
   `script`(인라인 내용)만 넘기면 해결된다.
3. **DO는 `useSQLite: true` 선언이 필수.** 없으면 agents SDK의 `storage.kv`
   동기 API가 500을 낸다
   ("only available for SQLite-backed Durable Objects").
4. **esbuild 플랫폼은 `node`.** agents SDK가 `node:os`·`node:async_hooks` 등
   노드 내장을 끌어오므로 `platform: "neutral"`로는 번들이 안 된다.
   `platform: "node"` + `nodejs_compat` 플래그 조합으로 해결.
5. **npm install 위치 주의.** POC 디렉토리에 package.json이 없으면 `npm install`이
   상위 package.json(레포 루트)을 찾아 운영 node_modules에 설치한다.
   그래서 스크립트는 `/tmp/agents-poc-deps`에 `--prefix`로 격리 설치한다.
   (작업 중 1회 실수로 레포 node_modules에 agents가 설치됐으나
   `npm rm agents --no-save`로 제거했고, 운영 package.json은 건드리지 않았다.)

## NOT TESTED (정직하게 적는다)

- **에지 하이버네이션 복귀 지연.** 로컬 miniflare는 DO를 evict하지 않는다.
  실측에는 별도 스크래치 Worker를 Cloudflare에 올려(무료 티어) 재워보고 깨워봐야 한다.
- **WebSocket 실시간 채팅.** `routeAgentRequest`가 WS 업그레이드를 지원하지만
  POC는 HTTP만 측정했다. 실시간 동기화는 Agents SDK의 핵심 가치라 확대 전 실측 필수.
- **실제 LLM 연결 (캘리=Groq).** 스텁 파서만 썼다. 모델 호출 지연·FC 루프가
  30초 예산에 미치는 영향은 미측정이다.
- **에지에서의 30초 제한 강제.** miniflare는 제한을 강제하지 않는다.
  플랫폼 제한은 문서상 수치(30초)만 확인했다.
- **다중 인스턴스·동시성.** 단일 인스턴스(`default`)만 썼다. 비서별 DO가 여럿일 때의
  동작·비용은 미측정이다.
- **운영 배포·트래픽 전환.** 일절 하지 않았다.

## 다음 단계 (확대한다면, 순서대로)

1. 별도 스크래치 Worker를 무료 티어에 올려 에지 실측: 하이버네이션 복귀 지연,
   WebSocket 왕복 지연, 30초 제한 하의 Groq FC 루프.
2. 통과하면 캘리 1명만 Agents SDK로 이중 운영(D1 원천 유지, DO는 세션·알림 전담)해
   기존 `/api/ai/chat` 경로와 결과를 비교한다.
3. 그 다음에야 루미·에코·노바 확대 여부를 판단한다. `agents` 최신 버전(측정 시
   0.30.1)과 0.24.0 사이 API 변경점도 그때 다시 확인한다.
