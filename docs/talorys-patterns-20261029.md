# Talorys 패턴 3종 이식 설계 — 2026-10-29

> 범위: **설계만.** 이 문서는 코드를 수정하지 않는다. 구현·병합·배포는 별도 결정.
> 대상 패턴 (2026-10-29 트렌드 조사 `~/workspace/your_files/trend-research-20261029.md` §①D·§③#6, 조건부 GO):
> ① 메모리 충돌 검토 큐 ② 계획 카드 exactly-once ③ 예약 실행 시 MCP 차단.
> MyHub 실측 기준: 저장소 HEAD `f763965` (2026-10-29), 마이그레이션 최신 0061.
>
> **라이선스:** Talorys는 **MIT 라이선스**다 (AGPL 아님 — GitHub 저장소 페이지에서 직접 확인, §1).
> 이 문서는 **코드를 복사하지 않고 설계 패턴만 참고**한다. 임계값·상태 이름 같은 설계 파라미터를
> 거론할 때도 Talorys 구현 코드가 아니라 공개 문서(README·docs)의 서술을 근거로 하며,
> MyHub 쪽 설계는 전부 MyHub 기존 코드·테이블·관용구에 맞춰 새로 쓴 것이다.

---

## 0. 요약 판정표

| # | 패턴 | MyHub 현황 판정 | 도입 비용 | 한 줄 근거 |
|---|---|---|---|---|
| ① | 메모리 충돌 검토 큐 | **부분적** — 재료는 있고 큐가 없다 | **중간** | `contradiction_flag`·supersede 계보·모순 탐지기(수면 통합)는 있으나, 충돌 "쌍"을 담는 검토 큐·검토 UI·쓰기 시점 검출이 없고, 중복 병합은 사람 검토 없이 자동 실행된다 (Talorys가 명시적으로 피하는 방식) |
| ② | 계획 카드 exactly-once | **없음** (카드 자체가 없음) + 원자적 claim 패턴은 타 도메인에 **있음** | **높음** (단, 승인 실행 claim만 떼면 낮음) | MyHub의 "계획"은 내부 Plan & Execute(비서 분해)뿐이고 사용자 확인용 계획 카드는 없다. 반면 lease claim·idempotency_key·claim-once 등 exactly-once 어휘는 artifact 잡·워크플로·핸드오프에 이미 실증돼 있다 |
| ③ | 예약 실행 시 MCP 차단 | **구조적으로 충족, 명시적 차단은 없음** (방향 차이 주의) | **낮음~중간** | Talorys는 MCP *클라이언트*(소비) 차단, MyHub는 MCP *서버*(제공)라 문자 그대로의 이식 대상이 없다. 번역한 원칙(예약 실행이 대화 세션의 도구 권한을 상속하지 않음)은 현재 크론 경로가 도구를 아예 호출하지 않아 사실상 지켜지지만, 코드·타입·테스트로 고정돼 있지 않아 미래의 예약 AI 루틴이 깨뜨릴 수 있다 |

권장 순서: **③-A (실행 출처 분리, 저렴·예방적) → ①-a (검토 큐 본체) → ②-0 (승인 재실행 claim, 소규모) → ② 본체 (계획 카드, UI 포함 최대 작업) → ①-c·③-B (조건부·보류)**.

---

## 1. Talorys 쪽 확인 범위 (무엇을 직접 봤고, 못 봤는지)

### 1.1 직접 열람한 것 (2026-10-29, `browser.open` 텍스트 열람)

- 저장소: `github.com/rociiu/talorys` — 페이지 표기 기준 스타 1,415·포크 134·커밋 138,
  기본 브랜치 main, 당시 커밋 `a74c55faab8cd8aaefac7f8aa345fed633682e86`, **License: MIT License**.
  구조: Pages(React) + 비공개 Worker(Hono) + Agents SDK Durable Object(SQLite 단일 저장소)
  + Workers AI(`@cf/zai-org/glm-4.7-flash`). D1·KV·Vectorize·Workflows는 **쓰지 않는다**
  (README §3 명시) — 저장 계층은 MyHub(D1)와 다르므로 패턴은 저장 방식과 분리해서 읽어야 한다.
- `README.md` 본문 — 패턴 3종의 1차 서술이 전부 여기서 확인된다 (아래 §2~§4 각 절 인용).
- `docs/memory-history.md` 전문 (242줄) — 패턴 ①의 상태·판정표·검토 UI·AI 체크 임계값 상세.
- `docs/mcp.md` 전문 (347줄) — 패턴 ③의 정확한 범위("Chat only")와 승인 exactly-once 서술.

### 1.2 확인 못 한 것 (문서에 명시 — 추측으로 메우지 않는다)

- **패턴 ②의 내부 메커니즘.** README에는 계획 카드의 *동작 약속*("confirming creates
  everything at once, exactly once")만 있고, README 개요에 계획 카드 전용 문서가 없다.
  트렌드 보고서의 "멱등 카드 ID"라는 요약 표현은 2차 서술이며, 카드 ID를 어떻게 만들고
  어디에 claim을 거는지는 **이번 열람으로 확인하지 못했다** (소스 코드를 줄 단위로 읽지
  않았고, 그럴 계획도 없다 — 설계 참고가 목적). 따라서 §3의 MyHub 설계는 Talorys 메커니즘의
  복제가 아니라, MyHub 자체의 기존 claim 패턴(§3.2.3)에서 도출한 독자 설계다.
- Talorys의 자동화(alarm) 내부 실행 코드, 메모리 충돌 탐지의 실제 구현 코드 — 문서 서술까지만 확인.
- 트렌드 보고서의 자기 고백 인용("핵심 로직에 테스트가 없다")은 보고서 기준이며 이번에 재검증하지 않았다.

---

## 2. 패턴 ① 메모리 충돌 검토 큐

### 2.1 Talorys의 형태 (문서 확인분)

출처: README "Memory history" 항목 + `docs/memory-history.md`.

- **상태 3종:** 모든 기억은 `Current`(현재 사실) / `Historical`("Past", 과거 사실) /
  `Unsure`(오래됐을 수 있음) 중 하나. 기존 기억은 전부 Current로 시작.
- **검출 시점:** 기억을 **저장·수정할 때만** (Memory 페이지 저장, 채팅의
  `remember`/`update_memory` 도구). 모든 채팅 메시지마다 돌리지 않는다.
- **검출 대상:** 단어를 공유하는 관련 기억 + 단일값 주제(거주지·차·직업·식단·관계 등
  "하나만 참일 수 있는" 주제)의 기존 기억.
- **기본(무AI) 판정 — 핵심은 "자동으로 아무것도 은퇴시키지 않는다":**

  | 새 기억 vs 기존 | 결과 |
  |---|---|
  | 명시적 교체 ("London에서 New York으로 이사") | 둘 다 유지 + *Needs review* 등록 |
  | 단일값 주제의 명시적 변경 | 둘 다 유지 + *Needs review* 등록 |
  | 더 상세한 버전 | 둘 다 유지 + *Needs review* 등록 |
  | 같은 주제, 불명확 ("Paris에 산다" vs "London에 산다") | 둘 다 유지 + *Needs review* 등록 |
  | 추가/무관 ("Paris에 다녀왔다") | 아무 변화 없음 |

  영문 표현 규칙("sold", "moved", "no longer", "replaced" …)은 교체 *후보를 표시*할 뿐
  은퇴시키지 않는다. `update_memory`로 재서술할 때만 새 기억 저장 + 기존 기억을
  "대체됨"으로 연결 (사용자의 Correct 조작과 동일 취급 — 에이전트가 지울 수 없게).
- **선택적 AI 체크 (기본 OFF):** Clef(`@cf/cloudflare/clef`, Workers AI)를 쓴다.
  규칙 + 의미 유사도(코사인 ≥ 0.60, 최대 3개)가 *후보를 지명*만 하고, Clef 1회 호출이
  관계를 판정한다. 확률 **≥ 0.8로 "교체"면 기존 기억이 자동으로 Past가 된다 (되돌리기 가능)**.
  그 아래는 전부 Needs review. 유사도만으로 찾은 충돌은 확률 ≥ 0.7 필요.
  3초 타임아웃·한도 소진·오류 시 규칙 판정으로 폴백 (아무것도 은퇴시키지 않음).
  사실의 날짜는 사용자가 말했을 때만 기록하고, 저장 시각을 사실 날짜로 취급하지 않는다.
- **검토 UI (Memory 페이지 *Possible conflicts*):** 새/기존 기억을 나란히 보여주고
  4가지 결정 — **Keep both**(둘 다 Current) / **Mark older as past**(기존을 역사로) /
  **Replace older**(기존을 영구 삭제) / **Discard newer**(새 기억을 영구 삭제).
  필터: All · Current · Historical · Needs review. 개별 조작: Update this fact(새 버전
  저장+기존 역사화) / Edit(제자리 오타 수정, 역사 없음) / Mark as past·Restore / History / Delete.
- **모델이 보는 것:** 턴당 최대 8개, `current` / `possibly outdated` /
  `historical — not current` 라벨 구간으로 분리. 과거 사실은 과거를 묻는 질문일 때만,
  무엇으로 대체됐는지와 함께 포함.
- **주변 규칙:** 백업에는 상태·날짜·대체 링크가 포함되지만 **대기 중 검토 건은 백업에
  포함되지 않는다**. 삭제하면 그 기억의 검토 건·링크도 함께 제거된다.

### 2.2 MyHub 현재 구조 (코드 실측)

#### 저장·쓰기 경로

- 스키마: `ai_memory_v2` (0027 + 0044 확장). 상태는 enum이 아니라 직교 플래그 조합이다 —
  `is_active`, `superseded_by`/`supersedes`(대체 계보), `contradiction_flag`(0044),
  시간 엣지 `memory_fact_entities.valid_from/valid_until`(0056). Talorys의
  Current/Historical/Unsure 3상태와 1:1 대응이 없다 (Historical ≈ `is_active=0 +
  superseded_by`, Unsure ≈ `contradiction_flag=1`로 *근사*만 가능).
- `POST /api/memory` (`src/modules/memory/routes.ts`): 정확 일치 중복 → 409,
  `normalizeForDuplicate` 기준 near-duplicate(최근 200개 스캔) → 409. **그 외 충돌
  검사는 없다.** "서울에 산다" 저장 후 "부산에 산다"를 저장하면 둘 다 활성·인용
  가능한 사실로 공존하고, 아무 표시도 남지 않는다.
- `PUT /api/memory/:id`: **제자리 덮어쓰기.** Talorys의 Edit(오타 수정)에 해당하지만,
  사실 변경에 써도 역사가 남지 않는다 — Talorys 원칙 "Nothing is silently
  overwritten"와 정면으로 다른 지점.
- `captureFacts` (`src/services/fact-graph.ts`): 메모·대화·성찰에서 사실을 추출해
  저장. near-duplicate만 `skipped`로 거르고, 상충 사실은 그대로 신설한다.
  호출원: `/api/memory/extract`, `/api/memory/memos/:id/capture`(잠긴 메모 거부),
  성찰 `reflectOnTask` (`src/services/memory-reflection.ts`).
- 수동 조작 API는 이미 있다: `POST /api/memory/:id/supersede`
  (`supersedeMemory`, `src/services/memory-service.ts` — 원자 batch로 계보 기록 +
  `closeFactTemporalEdges`), `/:id/restore`(+엣지 재개), `/:id/contradiction`
  (`markContradiction`). **즉 결정 *집행* 수단은 있고, 결정 *대기열*이 없다.**

#### 모순 탐지 (있으나, 검토 큐로 이어지지 않음)

- `runSleepConsolidation` (`src/services/memory-consolidation.ts`, 매일 03:00 KST,
  `src/scheduled.ts`의 `handleSleepConsolidation`):
  - `detectContradiction(a, b)`: 결정적 규칙 — 정규화 동일이면 제외(병합 대상),
    한쪽에만 부정·변경 표지(`NEGATION_MARKERS`: 아니다·취소·변경·바뀌·…)가 있고
    토큰 교집합 비율 ≥ 0.4 (엔티티 공유 시 ≥ 0.25, 최소 2토큰)면 모순 의심.
    최신 200개 쌍비교.
  - 탐지되면 **양쪽 행에 `contradiction_flag=1`** 만 세운다 (`markContradiction`).
    어느 기억과 충돌하는지(쌍 정보)는 어디에도 저장되지 않는다 —
    `memory_consolidation_log`(0053)에 `action='contradiction'` 감사 행은 남지만
    이것은 로그이지 처리 가능한 큐가 아니다.
  - **중복 병합은 자동이다:** `findDuplicateGroups` + `pickMergeSurvivor`로 패자를
    사람 검토 없이 즉시 supersede한다. near-duplicate(표기 차이) 한정이라 위험은
    낮지만, 방향은 Talorys("자동 은퇴 금지, 표시는 하되 결정은 사람")와 반대다.
- 읽기 경로: `formatMemoryContext` (`memory-service.ts`)가 모순 기억에
  `[모순 의심]` 태그를 붙여 **둘 다 사실로 주입**한다. `fetchSupersededMatches`로
  대체된 기억은 `[대체됨 → 기억 #N]` + 인용 불가로 구분하지만, 모순 쌍에는
  그런 "possibly outdated" 구간 분리가 없다.
- 노출 단절: `GET /api/memory`는 `contradiction_flag`·`superseded_by`를 **조회조차
  하지 않고**, `public/memory.html`에는 충돌 표시·필터·검토 UI가 전혀 없다
  (목록/수정/보관/영구삭제만). 플래그는 사실상 모델 주입 태그 전용으로만 쓰인다.

#### 판정: **부분적**

재료 — supersede 계보, 시간 엣지, 모순 탐지 규칙, 수동 supersede/restore/flag API,
감사 로그 — 는 갖춰져 있다. 없는 것: ① 충돌 **쌍**을 담는 검토 큐 엔터티
② 쓰기 시점 검출 (현재는 새벽 배치뿐) ③ 검토 UI와 결정 API ④ 자동 병합의 검토
전환 ⑤ Unsure에 해당하는 읽기 경로 구간 분리.

### 2.3 도입 설계 (없는 부분만)

#### 2.3.1 신규 테이블 — 마이그레이션 0062 (개요)

```sql
CREATE TABLE memory_conflict_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  new_memory_id INTEGER NOT NULL REFERENCES ai_memory_v2(id),
  old_memory_id INTEGER NOT NULL REFERENCES ai_memory_v2(id),
  reason TEXT NOT NULL CHECK (reason IN
    ('wording_rule','consolidation','clef','semantic','manual')),
  detail TEXT NOT NULL DEFAULT '',        -- 어떤 규칙/표지가 걸렸는지 (감사·UI 표시용)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','keep_both','marked_past','replaced','discarded_new','superseded_auto')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK (new_memory_id <> old_memory_id)
);
-- 같은 쌍의 대기 건 중복 방지 (부분 유니크)
CREATE UNIQUE INDEX idx_conflict_reviews_pair_pending
  ON memory_conflict_reviews (new_memory_id, old_memory_id) WHERE status = 'pending';
CREATE INDEX idx_conflict_reviews_status ON memory_conflict_reviews (status, created_at);
```

- 쌍 방향 규칙: `new` = 나중에 생긴 기억, `old` = 기존 기억. 통합 배치가 찾은 쌍은
  `updated_at` 최신 쪽을 new로 한다.
- Talorys와 마찬가지로 **대기 중 검토 건은 백업 대상에서 제외**한다 (백업 테이블
  분류표 `src/modules/backup/routes.ts`의 제외 목록에 추가하고 사유를 테스트로 고정 —
  기존 "포함 32/제외 20" 분류 관행과 동일).

#### 2.3.2 검출 — 쓰기 시점 + 배치 재활용

신규 `src/services/memory-conflict.ts` (순수 판정 + 큐 적재):

- `findConflictCandidates(rows, newRow)`: 기존 자산을 재사용한다 —
  토큰화는 `contentTokens`, 모순 판정은 `detectContradiction`
  (둘 다 `memory-consolidation.ts`에서 export 중), 엔티티 겹침은
  `memory_fact_entities` 조회. 단일값 주제 사전(거주지·차 등 영어 주제 목록)은
  MyHub에 없으므로 **한국어 표지 규칙으로 대체**한다: 기존 `NEGATION_MARKERS`에
  이사·퇴사·교체·판매 같은 변경 동사를 더한 "변경 표지" 집합 + 엔티티 공유를
  필수 조건으로 걸어 오탐을 줄인다. (Talorys의 주제 목록을 옮겨오지 않는다 —
  한국어 사실 문장에서는 엔티티+변경표지가 더 정직한 근사다.)
- 적재 함수 `enqueueConflictReview(env, newId, oldId, reason, detail)`:
  `INSERT OR IGNORE` (부분 유니크 인덱스가 중복을 막음).
- 접점 3곳 (전부 "저장 성공 후, best-effort" — 큐 적재 실패가 저장을 막지 않음):
  1. `POST /api/memory` (`routes.ts`) — 저장 직후 최근 활성 200개 중 후보 스캔.
  2. `captureFacts` (`fact-graph.ts`) — `created` 루프에서 신설 사실마다 후보 스캔.
     단, 성찰(reflection) 경유 자동 캡처는 스팸 위험이 있어 배치(통합)로만 지명하고
     쓰기 시점에서는 건너뛴다 (호출자가 `nominate: 'immediate' | 'batch'` 선택).
  3. `PUT /api/memory/:id` — **동작을 바꾸지 않는다** (오타 수정 용도 유지).
     대신 "사실 정정" 동선을 신설한다: UI에서 정정은 새 기억 저장 + 구 기억과의
     검토 건 자동 생성이며, 이는 Talorys의 Update this fact와 같다. API로는 기존
     `POST /api/memory` + 큐 적재로 이미 표현 가능하므로 신규 엔드포인트는 두지 않는다.

#### 2.3.3 수면 통합의 전환 (자동 병합 → 지명)

`runSleepConsolidation`에 플래그 `memory.conflict_review_enabled`(ai_settings,
기본 OFF로 도입해 켜는 순간부터 전환)를 건다:

- ON이면: 중복 그룹 병합은 **near-duplicate 중에서도 표기 차이만 있는 경우로 한정**
  하던 현행 자동 supersede를 유지할지, 검토로 돌릴지 — 권장: 현행 near-duplicate
  자동 병합은 유지(정규화 문자열이 *완전히* 같은 경우만이라 의미 충돌이 아님)하고,
  `detectContradiction` 쌍은 flag만 세우는 대신 **검토 건을 적재**한다.
  감사 로그는 그대로 남긴다 (action에 `review` 추가는 0053의 CHECK 제약과
  충돌하므로 detail에 표기하고 action은 'contradiction'을 유지).
- OFF(현행): 동작 무변경. — 플래그로 되돌릴 수 있어야 기존 새벽 배치가 깨지지 않는다.

#### 2.3.4 결정 API + 집행 (기존 함수 재사용)

`src/modules/memory/routes.ts`에 추가:

- `GET /api/memory/reviews?status=pending` — 쌍의 양쪽 본문·카테고리·생성일·reason·
  detail을 함께 반환. `GET /api/memory` 응답에도 `contradiction_flag`,
  `superseded_by`, `pending_review_count`를 포함하도록 조회 컬럼을 확장한다
  (UI 표시의 전제).
- `POST /api/memory/reviews/:id/decide` `{ action }` — 원자적 선점으로 시작한다:
  `UPDATE ... SET status=?, decided_at=? WHERE id=? AND status='pending'`,
  `changes !== 1`이면 409 (이미 결정됨). action 매핑:
  - `keep_both` — 양쪽 flag 해제(`markContradiction(..., false)` ×2)만.
  - `mark_past` — `supersedeMemory(old, new)` + `closeFactTemporalEdges(old)`.
  - `replace_older` — 영구 삭제 경로 재사용 (현행 DELETE permanent의 자식 행
    정리 순서: `memory_fact_entities`·`memory_relations` 먼저) + 이 쌍의 다른
    pending 검토 건 정리.
  - `discard_newer` — 위와 대칭 (new 쪽 영구 삭제).
- 삭제 시 그 기억이 걸린 다른 pending 검토 건은 `status`를 건드리지 않고 조회 시
  조인으로 자연히 사라지게 하지 말고, decide/삭제 경로에서 함께 정리한다
  (고아 pending이 UI에 뜨는 것을 막기 위함 — Talorys도 삭제 시 검토 건을 지운다).

#### 2.3.5 읽기 경로 (Unsure 구간)

`formatMemoryContext` (`memory-service.ts`): pending 검토에 걸린 기억에
`[검토 중 — 최신 여부 미확정]` 태그를 추가하고, 인용 잠금 문구
(`MEMORY_CITATION_INSTRUCTION`)에 "검토 중 기억은 단정하지 말고 양쪽 가능성을
밝힐 것"을 한 줄 더한다. Talorys처럼 별도 구간(`possibly outdated`)으로 분리하는
것은 2단계로 미룬다 — 태그만으로 시작해도 현행 `[모순 의심]`보다 정보가 늘고,
프롬프트 구조 변경 위험이 작다.

#### 2.3.6 UI

`public/memory.html`: 상단에 "충돌 검토" 섹션 (pending 건만, 양쪽 나란히 +
결정 버튼 4개), 목록 필터에 "검토 중" 추가, 기억 항목에 모순/검토 중 배지.
디자인은 기존 `.memory-item` 카드 재사용 (신규 디자인 시스템 금지).

#### 2.3.7 선택 단계 — Clef AI 체크 (①-c, 보류 권장)

Talorys는 Clef 확률 ≥ 0.8일 때만 자동 Past 처리를 허용한다. MyHub에는 Clef 호출
자산(`createClefInvoker`, `src/services/router.ts`)이 있으나 용도가 비서 라우팅이고
`CLEF_ROUTER_ENABLED=false`다. 도입한다면: 플래그
`memory.llm_conflict_check_enabled` 기본 OFF, 후보 지명(규칙) 뒤 1회 판정,
≥ 0.8 "교체"면 `marked_past`를 *자동 결정*으로 기록(결정한 주체가 Clef임을
status/detail에 명시), 미만이면 pending 유지, 실패·타임아웃이면 규칙 결과 유지.
**권장: 큐 본체가 운영에서 오탐률을 보여준 뒤에 결정.** 큐 없이 자동 은퇴부터
켜는 것은 이 패턴의 본질(사람 결정)에 반한다.

### 2.4 복잡도·리스크 (패턴 ①)

- **복잡도: 중간.** 신규 테이블 1개 + 순수 판정 모듈 1개 + 라우트 2개 + 통합
  분기 + UI 섹션. 집행 수단은 전부 기존 함수 재사용이라 핵심 로직 신규 작성은
  후보 판정뿐이다. Clef 단계(①-c)를 빼면 중간 하한.
- 깨질 수 있는 것:
  - `captureFacts` 핫패스 지연 — 후보 스캔은 최근 200개 제한을 그대로 쓰고,
    사실당 O(200) 토큰 비교가 캡처 배치(최대 10건)에 곱해진다. 메모 캡처 체감
    지연이 생기면 스캔 상한을 낮추는 것으로 조정 (정확도보다 응답성 우선 지점 명시).
  - 검토 스팸: 성찰·자동 캡처가 쌓는 사실이 검토 건을 폭증시키면 큐가 방치되고
    패턴 전체가 무력해진다. 위 설계에서 자동 캡처의 즉시 지명을 끈 이유다.
  - 기존 테스트: `memory.html`·통합 관련 Jest가 "자동 병합"을 기대하는 케이스는
    플래그 OFF 기본값 덕에 무변경이어야 하고, ON 케이스는 카나리아로 추가한다
    (플래그를 끄면 테스트가 실패하는 형태 — 연극 테스트 금지 원칙).
  - `GET /api/memory` 응답 확장은 하위 호환 추가만 (필드 삭제·이름 변경 금지).

---

## 3. 패턴 ② 계획 카드 exactly-once

### 3.1 Talorys의 형태 (문서 확인분 — 약속 수준까지만)

README "AI task planning" 항목이 전부다:

> 목표를 말하면("Plan the tasks to launch my iOS app next month") 계획이 채팅 안의
> **상호작용 카드**로 제안된다. 작업을 검토·수정·제거하고 프로젝트를 고른 뒤
> **확인한다: 확인 전에는 아무것도 생성되지 않고, 확인하면 전부 한 번에,
> 정확히 한 번(exactly once) 생성된다.**

보조로 `docs/mcp.md`의 승인 규칙이 같은 철학을 보여준다: 승인은 정확한 인자에
묶이고 **"Each approval runs at most once"**, 승인된 호출은 **자동 재시도하지
않으며**, 전송 후 실패하면 "실행됐을 수도, 안 됐을 수도 있다"고 정직하게 보고한다.
카드 ID·claim 방식 같은 내부 메커니즘은 §1.2대로 **미확인**이다.

### 3.2 MyHub 현재 구조 (코드 실측)

#### 3.2.1 "계획"이라 불리는 것은 있으나 카드가 아니다

- `planTeam` (`src/services/agent-team.ts`): 복합 요청을 접속사로 절 분리해
  비서별 단계(`TeamStep`)로 만드는 **내부 실행 계획**이다. 사용자 검토·수정·확인
  단계가 없다 — `src/modules/ai/routes.ts`가 `planTeam` 직후 같은 요청 안에서
  `runTeam` → `executePlan` (`src/services/plan-execute.ts`)으로 **즉시 실행**한다.
- `executePlan`: 단계별 실행 + 구조 검증 + **최대 2회 재시도(총 3회)**.
  - `orchDeps`에 `approvalChecker`가 전달되지 않아(라우트 실측) 파괴적 단계는
    전부 스킵되는 fail-closed 상태다 — 안전하지만 "계획 승인"과는 다르다.
  - 단계 실행(`callAssistant`) 내부에서 도구 마커가 실행될 수 있는 구조에서
    재시도는 **부작용을 동반한 단계를 다시 실행**할 수 있고, 단계 단위 멱등 키가
    없다. (실제로 어느 단계가 부작용을 내는지는 구현 단계에서 호출 경로를 확정해
    검증할 것 — 이 문서는 "멱등 장치가 없음"까지만 단정한다.)
  - `createRun`은 매 호출 새 `runId`(시각+난수)를 만들어 `agent_runs`에 쌓는다.
    같은 사용자 요청을 클라이언트가 재전송하면 **새 run이 생기고 중복 실행을
    막을 키가 없다.** 체크포인트(`agent_run_checkpoints`, `UNIQUE(run_id,
    step_index)`)와 `driveRun`의 재개(완료 단계 건너뜀)는 *한 run 안*의
    이어하기를 보장할 뿐, run 생성 자체의 중복은 막지 못한다.

#### 3.2.2 단건 승인 흐름 — 카드의 절반, exactly-once의 절반

- `ToolApprovalRequestStore` (`src/services/approval-flow.ts`, 0052):
  도구 마커 1건의 실행을 보류하고 승인 카드 문안(무엇을·근거·되돌릴 수 있는지·
  영향)을 채팅으로 보여준다. 게이트(`src/modules/ai/tool-markers.ts`)는 같은
  대화·같은 scope의 pending이 있으면 **재사용**한다 (`findPendingByScope`) —
  중복 카드 생성 방지는 있다.
- 결정 전이는 원자적이다: `resolveRequest`는 `UPDATE ... WHERE status='pending'`
  + `changes` 확인. 두 번 승인해도 두 번째는 매칭되지 않는다.
- **그러나 승인 후 재실행에는 claim이 없다.** 0052 마이그레이션 주석이 명시한다:
  "executed 상태는 두지 않는다 — 실행 실패와 성공을 이 테이블이 판정하지 않기
  위함". 즉 승인된 마커의 재실행 요청이 어떤 사유로든 두 번 도달하면 두 번
  실행될 수 있고, 이를 막는 것은 호출 경로의 관행뿐이다.
- 생성 도구 자체도 멱등하지 않다: `todo-tools.ts`·`schedule-tools.ts`·
  `memo-tools.ts`의 INSERT에는 dedupe 키가 없다 (순수 INSERT).

#### 3.2.3 exactly-once 어휘는 코드베이스 다른 곳에 실증돼 있다

| 자산 | 방식 | 위치 |
|---|---|---|
| 아티팩트 잡 | lease claim: `UPDATE ... WHERE status='pending' OR lease 만료` + `lease_token` 소유권, `changes=0`이면 busy/done 판정 | `src/modules/artifact/job-processor.ts` `processArtifactJob`·`claimJob` |
| 워크플로 실행 | `idempotency_key` 선점(`claimRun`): 완료/실패 키는 재실행 없이 저장된 출력 반환, running 15분 stale만 재실행 허용 | `src/services/workflow.ts` (0050 `workflow_runs`) |
| 자연어 크론 | `next_run_at` CAS 선점 (`UPDATE ... WHERE next_run_at=?`, 실패 시 복원해 재시도) | `src/services/cron-jobs.ts` `advanceNextRun` |
| 일정 리마인더 | `reminders.dedupe_key` `INSERT OR IGNORE` 선점 | `src/scheduled.ts`, `src/services/reminder-workflow.ts` |
| 기억 인계 | claim-once: `UPDATE ... WHERE status='pending' AND expires_at>?` + `changes=1` 확인 | `src/services/memory-service.ts` `claimHandoff` |
| 아티팩트 API | 중복 제출 시 `{ deduped: true }` 반환 | `src/modules/artifact/routes.ts` |

즉 "원자적 선점 → 소유권 토큰/상태로 집행 → 중복 호출에는 저장된 결과 반환"이라는
이 코드베이스의 문법이 이미 6곳에서 쓰인다. 계획 카드에 없는 것은 문법이 아니라 **적용**이다.

#### 판정: **없음** (계획 카드) / **부분적** (exactly-once 기반 기술)

Talorys 패턴의 사용자 경험 단위(검토 가능한 다건 계획 카드 + 확인 1회 = 전체
정확히 1회 생성)는 존재하지 않는다. 가장 가까운 것은 단건 승인 카드이며,
그것도 실행 claim이 비어 있다.

### 3.3 도입 설계

두 단계로 나눈다. ②-0은 기존 승인 흐름의 구멍을 메우는 소규모 선행 작업이고,
② 본체는 신규 도메인이다.

#### 3.3.0 선행 (②-0): 승인 재실행 claim — 기존 0052에 executed 상태 추가

- 마이그레이션 0063 (개요): `tool_approval_requests`에 `executed_at TEXT`,
  `execution_result TEXT` 컬럼 추가 (추가형 ALTER만).
- 재실행 직전 원자적 선점: `UPDATE tool_approval_requests SET executed_at=?
  WHERE id=? AND status='approved' AND executed_at IS NULL` — `changes=1`인
  호출만 마커를 실행하고, `0`이면 이미 실행됐음을 알리고 저장된 결과를 안내한다.
  실행 실패 시에는 `executed_at`을 되돌리지 **않는다** (Talorys MCP 규칙과 동일:
  부작용이 났을 수 있는 실패를 자동 재시도하지 않고 "실행됐을 수 있음"으로 보고).
  사용자가 명시적으로 다시 요청하면 새 승인 건이 생기는 것이 올바른 복구 경로다.
- 0052 주석의 설계 의도("실행 성패를 이 테이블이 판정하지 않음")와 충돌하지
  않게, `execution_result`는 성공/실패 판정이 아니라 "시도 사실 + 결과 요약
  (생성된 리소스 id 등)"의 감사 기록으로만 쓴다.

#### 3.3.1 본체: 계획 카드 도메인 — 마이그레이션 0064 (개요)

```sql
CREATE TABLE plan_cards (
  id TEXT PRIMARY KEY,                    -- 서버 발급 UUID (카드 식별자)
  idempotency_key TEXT NOT NULL UNIQUE,   -- 아래 규칙으로 계산, 카드 재생성 방지
  conversation_id INTEGER NOT NULL,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','executing','done','partial','failed','cancelled','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,               -- 제안 후 30분 (승인 10분보다 길게: 검토 시간)
  confirmed_at TEXT,
  finished_at TEXT
);
CREATE TABLE plan_card_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES plan_cards(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('todo','schedule','memo')),
  payload_json TEXT NOT NULL,             -- 생성 인자 (마스킹 전 원본은 여기에만, 로그 금지)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','created','failed','removed')),
  created_resource_id INTEGER,            -- 생성된 todo/schedule/memo id (재개·표시용)
  error TEXT,
  UNIQUE (card_id, seq)
);
```

- **멱등 키 규칙:** `SHA-256(conversation_id + ':' + 원본 사용자 메시지 id +
  ':' + 정규화된 항목 목록 JSON)`. 같은 턴에서 같은 계획이 재생성되면(모델
  재호출·클라이언트 재전송) UNIQUE 충돌로 기존 카드를 반환한다. 정규화는
  항목 정렬·공백 제거까지만 (의미 정규화는 하지 않는다 — 다르면 다른 계획이다).
- **범위 제한 (v1):** 생성 전용 3종(todo/schedule/memo)만. 수정·삭제 항목은
  카드에 넣지 않는다 — 파괴적 작업은 기존 단건 승인 흐름이 계속 담당한다.
  잠금 관련 항목은 종류 자체가 없어 원천 차단된다.
- **생성 경로:** 채팅에서 모델이 다건 생성을 제안하면 마커를 즉시 실행하지
  않고 카드를 만들어 `draft`로 저장, 채팅 UI에 카드로 렌더링한다. 항목
  수정·제거는 카드 상태에만 반영되고 실제 리소스는 만들지 않는다
  (Talorys의 "확인 전 무생성"과 동일).
- **확인 = 원자적 선점 + 항목별 체크포인트 실행:**
  1. `POST /api/ai/plan-cards/:id/confirm` —
     `UPDATE plan_cards SET status='executing', confirmed_at=? WHERE id=?
     AND status='draft'`; `changes=0`이면 현재 상태와 항목 결과를 그대로
     반환한다 (중복 확인·더블 클릭·재전송이 두 번째 실행을 만들지 않음).
  2. 항목을 `seq` 순으로 실행하되, 항목마다 먼저
     `UPDATE plan_card_items SET status='created', created_resource_id=?
     WHERE id=? AND status='pending'` 방식으로 결과 기록을 집행과 묶는다.
     실행이 중간에 죽으면 카드는 `executing`에 남고, 재개 호출
     (`POST /:id/resume`, 또는 만료 스윕이 `executing` 15분 stale을 `partial`로
     표시 — workflow의 STALE_RUNNING_MS 관행과 동일 기준)이 `pending` 항목만
     이어서 실행한다. `created` 항목은 절대 재실행하지 않는다.
  3. 전부 성공 → `done`, 일부 실패 → `partial` + 실패 항목과 사유를 카드에
     그대로 표시 (조용한 실패 금지, Talorys의 불확실성 정직 보고와 동일 원칙).
     "전부 한 번에"는 사용자 경험(확인 1회로 전체 처리)의 약속이지 분산
     트랜잭션의 약속이 아니며, 부분 실패 시 상태가 카드에 남는 것이 그 대가다.
- **승인 체계와의 관계:** 카드 확인이 곧 승인이다. 카드 항목은 마커 게이트를
  거치지 않고 서비스 함수(`todo-tools`·`schedule-tools`·`memo-tools`의 생성
  함수)를 직접 호출하되, 확인 사실을 `tool_approvals`에 카드 단위 감사 행
  (scope_key = `PLAN_CARD:<card_id>`)으로 남긴다. 반대로 카드가 떠 있는 동안
  같은 생성 마커가 일반 경로로 들어오면 중복이 생기므로, 카드 생성 시점에
  해당 턴의 생성 마커 실행을 카드로 흡수하는 것이 라우트(`routes.ts`)의
  책임이다 — 이 접점이 설계상 가장 섬세한 부분이다.
- **만료:** `draft` 30분 경과 시 lazy expiry (조회 시 `expired` 전이,
  approval-flow의 lazy expiry 관행 재사용). 만료된 카드는 확인 불가.

#### 3.3.2 UI

채팅(`public/js/chat.js` 계열)에 카드 렌더링: 항목 행(종류 아이콘·제목·시각) +
행별 제거 + 전체 확인/취소 버튼 + 상태 표시(실행 중/완료/부분 실패).
기존 승인 문안 카드의 스타일을 재사용한다. 계획 *생성* 자체는 신규 UI가 아니라
서버 응답에 카드 페이로드가 실려 오는 형태다.

### 3.4 복잡도·리스크 (패턴 ②)

- **복잡도: ②-0은 낮음** (컬럼 2개 + UPDATE 1곳 + 테스트).
  **본체는 높음.** 이유: 신규 도메인(테이블 2개·상태기계) + 채팅 UI 카드 +
  마커 게이트와의 흡수 접점 + 재개/만료 처리. 항목 실행 자체는 기존 생성
  함수 재사용이라 어렵지 않으나, "카드·승인·마커" 세 체계의 경계 설계가
  작업의 본체다.
- 깨질 수 있는 것:
  - 마커 경로와 카드 경로가 같은 생성을 이중으로 실행하는 회귀 (위 흡수 접점).
    카나리아: 카드 확인 후 동일 턴 마커가 재실행되면 테스트 실패.
  - `plan-execute`의 재시도와 카드의 무재시도 원칙 혼동 — 두 "계획"은 별개
    도메인임을 코드·문서에서 이름으로 구분한다 (`plan_cards` vs `agent_runs`).
    내부 Plan & Execute 단계 재시도는 텍스트 생성 단계에 한해 유지하되,
    부작용 단계를 재시도 대상에서 빼는 작업은 별도 과제로 분리한다 (이 설계의
    범위를 넘지 않음).
  - 카드 payload에 시크릿성 텍스트가 저장될 수 있다 — `payload_json`은
    `secret-mask` 적용본을 UI 표시용으로, 원본은 실행용으로만 보관하고
    로그·감사에는 마스킹본만 남긴다 (tool-approval의 기존 원칙 그대로).

---

## 4. 패턴 ③ 예약 실행 시 MCP 차단

### 4.1 Talorys의 형태 (문서 확인분)

출처: README "Remote MCP servers" 항목 + `docs/mcp.md`.

- Talorys는 **MCP 클라이언트**다: 원격 MCP 서버를 Settings → Integrations에
  연결하고, 그 도구들을 **채팅 모델**이 쓸 수 있게 한다. 도구는 기본 OFF,
  켤 때도 도구별 "매번 묻기(기본)/묻지 않고 실행(읽기 전용용)"을 고른다.
- 핵심 문장 (README): MCP 도구는 **"Not used by scheduled routines"**.
  `docs/mcp.md`의 표현은 더 강하다: **"Chat only: MCP tools are never offered
  to scheduled AI routines."** — 호출 시점에 막는 게 아니라, 예약 실행의
  도구 *목록 자체*에 넣지 않는다 (offer 단계 차단).
- 함께 있는 가드레일: 예약 AI 실행의 일일 상한(`max scheduled AI runs per
  day`)이 별도로 있고, 단순 리마인더·다이제스트는 AI를 쓰지 않는다.
- 번역되는 원칙: **예약/백그라운드 실행은 대화 세션의 권한(승인·도구 허용)을
  상속하지 않는다.** 트렌드 보고서가 Meta "Agents Rule of Two"와 같은
  방향이라고 짚은 지점도 이것이다.

### 4.2 MyHub 현재 구조 (코드 실측)

#### 방향 차이 — 먼저 짚어야 할 것

- MyHub는 **MCP 서버**다: `POST /api/mcp` (`src/modules/mcp/routes.ts`,
  `server.ts`)가 외부 클라이언트에 읽기 도구 5개(`memo.search`,
  `schedule.list`, `todo.list`, `memory.search`, `briefing.generate`,
  전부 `mode: 'read'`, `readOnlyHint`)를 제공한다. 인증은 PIN 세션 또는
  Bearer MCP 토큰, 실행 컨텍스트는 `approvedWrites: false` 고정.
- MyHub에는 **MCP 클라이언트(원격 서버 소비)가 없다.** 따라서 "예약 실행에서
  MCP 도구를 빼라"를 문자 그대로 적용할 대상이 존재하지 않는다. 이 패턴의
  이식은 ③-A(원칙의 내재화)와 ③-B(미래 MCP 클라이언트 도입 시의 요구사항
  고정) 두 갈래로만 성립한다.

#### 예약 실행 경로의 실측 (전부 도구 표면이 없음)

`src/index.ts`의 `scheduled()`는 5분 틱마다 4개를 순서대로 부른다:

| 핸들러 | 하는 일 | AI/도구 사용 |
|---|---|---|
| `handleScheduled` (`src/scheduled.ts`) | 30분 내 일정 → Web Push (dedupe 선점) | AI 없음 |
| `handleCronJobs` → `runDueCronJobs` (`src/services/cron-jobs.ts`) | `morning-briefing`: 규칙 기반 `generateMorningSummary` (`proactive.ts`, AI 없음). `news-summary`: `generateNewsSummary` → `summarizeNewsWithModel` (`news-briefing.ts`) — `aiChat`을 **persona 없이 capability 'summarize'로만** 호출 (주석 명시: "FC 도구 미부착") | 요약 1회만, 도구 없음 |
| `handleSleepConsolidation` | §2의 기억 통합 (결정적 규칙, 외부 전송 없음, 잠긴 메모 미조회) | 도구 없음 |
| `handleGoogleSync` | Gmail/Calendar pull 동기화 (30분 간격 마커) | 도구 없음 |

네 경로 모두 MCP 도구 실행기·`buildMcpServer`·도구 마커 실행·`decideToolExecution`을
호출하지 않는다. **즉 원칙은 현재 "구조적 부재"로 지켜지고 있다** — 차단
코드가 있어서가 아니라, 예약 경로에 도구라는 개념 자체가 없어서다.
자동화 *생성* 쪽은 대화 경로의 게이트를 탄다: `CRON_CREATE`는 쓰기(승인 필요),
`CRON_DELETE`는 파괴적(반드시 승인)으로 `tool-approval.ts`에 분류돼 있다.

#### 그러나 고정돼 있지 않다

- `ExecutionContext` (`src/ai/types.ts`)에는 `userId`, `requestId`,
  `approvedWrites`, `mcpTasksExtension`뿐, **실행 출처(origin) 필드가 없다.**
  어떤 코드도 "이 실행은 예약 실행이다"를 표현할 수 없고, 게이트
  (`decideToolExecution`)도 출처를 물을 수 없다.
- 미래의 변경이 원칙을 깨는 경로는 구체적이다: 예약 AI 루틴(예: AI 아침
  브리핑 고도화)을 만들 때 편한 방법은 persona를 붙인 `aiChat`/`callAssistant`
  재사용인데, 그 순간 FC 도구·마커 실행이 예약 컨텍스트로 따라 들어간다.
  세션 허용은 대화 스코프(`SESSION:<conversationId>`)라 예약 실행이 그대로
  물려받지는 않지만, 도구 *제공*(offer) 자체는 막는 것이 없다.
- 외부 MCP 서버 쪽은 상시 열려 있다(토큰 인증, 읽기 전용이라 위험은 낮음).
  참고로 크론의 아침 브리핑(`generateMorningSummary`, 규칙 기반)과 MCP의
  `briefing.generate`(`buildTodayBriefing`)는 이름만 비슷하고 다른 코드다 —
  예약 실행이 MCP 도구를 "호출"하는 것으로 오독하지 않도록 명시해 둔다.

#### 판정: **부분적** — 원칙은 사실상 충족(구조적), 명시적 보장은 없음

### 4.3 도입 설계

#### 4.3.1 ③-A: 실행 출처(origin) 분리 — 지금 할 수 있는 전부

- `ExecutionContext`에 `origin: 'interactive' | 'scheduled' | 'mcp' |
  'channel'`를 추가한다. 생성 지점에서 명시한다: 채팅 라우트 = `interactive`,
  `src/modules/mcp/server.ts` = `mcp`(현행 `approvedWrites: false`와 함께),
  예약 경로에서 AI를 부르는 지점(현재는 `summarizeNewsWithModel` 1곳) =
  `scheduled`.
- 게이트 강제 (`decideToolExecution`, `src/services/tool-approval.ts`):
  `origin !== 'interactive'`인 실행에서는 쓰기·파괴적 도구를 `ask`가 아니라
  **`deny` (`reason: 'non_interactive_origin'`)** 로 막는다. 물을 상대가 없는
  컨텍스트에서 `ask`는 대기가 아니라 사실상 방치이기 때문이다. 읽기 도구는
  현행대로 허용하되, 예약 출처에서 허용할 읽기 목록을 좁히는 것은 후속
  판단으로 남긴다 (현재 예약 경로는 도구를 아예 안 쓰므로 v1은 쓰기 차단만
  으로 충분).
- 기본값 정책: origin 미지정 시의 폴백이 설계의 핵심이다. 기존 생성 지점이
  여럿이라 일괄 변경 중 누락이 생길 수 있으므로, **쓰기 판정에 한해
  미지정 = 비대화형으로 취급(fail-closed)** 하고, 기존 대화 경로부터 명시해
  테스트로 전 생성 지점을 열거·고정한다. (구현 단계에서 `ExecutionContext`
  생성 지점 전수 목록을 먼저 뽑는 것이 첫 작업이다 — 이 문서에서는
  그 목록을 추정으로 적지 않는다.)
- 회귀 테스트 (의미 있는 것만): ① scheduled origin + `MEMO_CREATE` →
  deny 카나리아 (게이트의 origin 분기를 지우면 실패해야 함) ② interactive
  origin의 기존 판정 전수 무변경 ③ `runDueCronJobs` 통합 테스트에서 도구
  실행기가 호출되지 않음.
- 문서화: `docs/`의 이 문서가 근거이고, 코드에는 `scheduled.ts` 헤더에
  "예약 경로는 도구를 제공받지 않는다 — AI가 필요하면 persona 없는
  capability 호출만" 원칙을 한 줄로 남긴다 (현행 news-briefing의 암묵
  관행을 명문화하는 것).

#### 4.3.2 ③-B: MCP 클라이언트를 도입하게 될 경우의 요구사항 (지금은 설계 고정만)

Talorys 문서에서 확인된 규칙을 MyHub 도입 시의 **수용 조건**으로 박아 둔다.
구현·테이블은 만들지 않는다:

1. 도구 목록 구성 단계에서 예약 실행에는 MCP 도구를 **넣지 않는다**
   (호출 시점 차단 금지 — offer 단계 차단).
2. 도구는 기본 OFF, 도구별 승인 모드, 켜진 도구 총수 상한.
3. 승인은 정확한 인자에 묶이고 최대 1회 실행, 자동 재시도 없음, 전송 후
   실패는 "실행됐을 수 있음"으로 보고.
4. 도구 정의(설명·스키마)가 바뀌면 재승인 전까지 자동 비활성화.
5. 전역 kill switch (env 1개로 MCP 클라이언트 전체 OFF).
6. 예약 AI 실행 일일 상한 (③-A와 별개로, Talorys의 scheduled runs cap에
   해당 — MyHub에 예약 AI 호출이 늘어나는 시점에 `ai_usage` 원장 기반
   카운터로 도입).

### 4.4 복잡도·리스크 (패턴 ③)

- **복잡도: ③-A는 낮음~중간.** 타입 필드 1개 + 게이트 분기 1곳 + 생성 지점
  plumbing + 카나리아 테스트. 작업량의 대부분은 생성 지점 전수 확인이다.
  **③-B는 해당 시점에 높음**이나 지금은 문서 고정뿐이라 비용이 없다.
- 깨질 수 있는 것:
  - fail-closed 기본값이 기존 비대화 경로(스튜디오 에이전트·채널 게이트웨이
    등 origin을 안 채우는 호출자)의 쓰기를 막는 회귀 — 그래서 생성 지점
    전수 열거가 선행 조건이며, 막히는 경로가 나오면 그 경로가 대화형인지
    예약형인지 *판정해서* 명시하는 것이 이 작업의 본래 목적이다.
  - 반대로 origin을 잘못해 `interactive`로 찍힌 예약 경로가 생기면 차단은
    무력해진다 — scheduled 핸들러에서 만드는 컨텍스트는 한 곳으로 모으는
    팩토리 함수를 강제하는 것으로 방어한다.

---

## 5. 공통 사항

### 5.1 세 패턴의 공통 설계 원칙 (MyHub 기존 관행과의 정합)

- **원자적 선점은 기존 문법으로:** `UPDATE ... WHERE <기대 상태>` +
  `changes` 확인 (핸드오프 claim, 크론 CAS, 승인 resolve와 동일).
  새 패턴마다 새 방식을 만들지 않는다.
- **자동 결정의 상한:** 자동화는 *지명*까지, 상태 변경 결정은 사람(①) /
  확인 1회의 원자 집행(②) / 출처 기반 원천 차단(③). 셋 다 "조용히
  실행하지 않는다"는 같은 원칙의 다른 얼굴이다.
- **플래그 기본값:** ①의 검토 전환과 Clef 체크는 `ai_settings` 플래그로
  기본 OFF 도입 후 전환 (memory.v2·llm_extract의 기존 관행). ②·③-A는
  안전 방향 변경이라 플래그 없이 카나리아 테스트로 고정한다.
- **마이그레이션 규율:** 번호는 0062부터 순서대로, 추가형 변경만,
  운영 적용은 기존 안전 규칙(단독 적용·Time Travel bookmark·행 수 확인)을
  따른다. 이 문서는 번호 배정안이며 실제 적용 순서는 구현 시점에 확정한다
  (②-0의 0063과 ①의 0062가 맞바뀔 수 있음 — 표의 번호는 충돌 방지용 가안).
- **테스트 원칙 (AGENTS.md 상시 계약):** 각 패턴마다 "성질이 깨지면 실패하는"
  카나리아를 명시했다 — ① decide 이중 실행 409, 큐 적재 중복 방지;
  ② confirm 이중 호출 시 항목 생성 수 불변, 재개 시 created 항목 재실행
  금지; ③ scheduled origin 쓰기 deny. 커버리지용 테스트는 만들지 않는다.

### 5.2 하지 않는 것 (범위 밖 명시)

- Talorys 코드 열람·복사 (문서 서술만 참고 — MIT라 복사가 *가능*해도 하지
  않는 것이 이 트랙의 전제).
- Durable Object 저장 계층, Talorys식 설치 마법사 등 패턴 3종 밖의 이식.
- MCP 클라이언트 신규 구현 (③-B는 요구사항 고정까지만).
- `plan-execute`(내부 Plan & Execute)의 재시도 정책 변경 — ②와 별도 과제.

### 5.3 구현 착수 시 확인이 필요한 열린 질문

1. ①: 단일값 주제의 한국어 근사(엔티티+변경표지)의 오탐률 — 큐 본체를 켜기
   전에 현행 통합 로그(`memory_consolidation_log`의 contradiction 건수)로
   규모를 먼저 가늠할 것.
2. ②: 카드 생성 트리거를 모델 제안(마커 흡수)으로 할지, 복합 생성 요청의
   규칙 판정(건수 ≥ 2)으로 할지 — 전자는 라우트 변경이 크고 후자는 단순하다.
   착수 시점에 채팅 로그의 다건 생성 빈도를 보고 결정.
3. ③-A: `ExecutionContext` 생성 지점 전수 목록과 각 지점의 origin 판정표
   (특히 스튜디오·채널 경로) — 첫 작업 산출물로 고정.

