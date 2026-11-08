# memora 대조 검증 메모 — MyHub memory-consolidation vs agentic-box/memora

- 작성: 2026-10-26 (트랙 C4+C5, 2-5절)
- 근거 문서: `docs/github-apply-research-20261026.md` 2-4절 (Graphiti) · 2-5절 (memora)
- 대조 대상: `agentic-box/memora` ★746 · MIT · HEAD `c5624e8` (2026-09-23, release v0.4.6)
  — 클론해 `memora/storage.py`(10,709줄) · `tests/test_absorb_supersede_gate.py`를 읽음.
  **코드 복사·설치 없음. 패턴 대조만.**
- 이번 트랙 반영: 마이그레이션 `0056_memory_fact_temporal_edges.sql` (파일만 작성,
  운영 DB 미적용) + `closeFactTemporalEdges`/`reopenFactTemporalEdges`/
  `resolveSupersedeLeaf` + 테스트 `tests/unit/svc-memory-temporal-edges.test.ts` 18건.

## 1. 한눈 비교

| 항목 | memora | MyHub (이번 트랙 이후) |
|---|---|---|
| 저장소 | SQLite (`memories` + `memories_crossrefs`) | D1 (`ai_memory_v2` + `memory_fact_entities` 등) |
| dedup 판정 | 코사인 유사도 (임베딩/TF-IDF) | 정규화 문자열 **완전 일치** (`normalizeForDuplicate`) |
| dedup 임계값 | 0.85 이상이면 LLM 없이 auto-skip; 0.35 이상이면 LLM 분류로 | 임계값 없음 (사실상 1.0) — 말만 바꾼 near-duplicate는 못 잡음 |
| supersede 판정 | 유사도 0.55 하한 → LLM 검증 (신뢰도 0.75) → 간선 생성 | 결정적 규칙 (정규화 동일 그룹, 최신 생존자) — LLM 없음 |
| 계보 표현 | `supersedes` / `superseded_by` **간선** (양방향 crossref) | `superseded_by` / `supersedes` **컬럼** (직접 포인터 1개씩) |
| 체인 해소 | `_walk_chain` BFS + `_resolve_latest` (리프 목록, 사이클 시 max(id) 폴백) | `resolveSupersedeLeaf` (순수 함수, 동일 규칙으로 이식) |
| 시간축 | 없음 (간선에 유효 기간 없음) | **0056 `valid_from`·`valid_until`** (Graphiti 패턴 — memora에는 없는 우리 우위) |
| 복원 | **없음** — 제자리 복원 불가 | `restoreMemory` + 엣지 재개 (`reopenFactTemporalEdges`) — memora와 정반대 |
| 삭제 후 재흡수 | **tombstone이 막음** (콘텐츠 해시, 컴포넌트 전체) | 막지 않음 — 삭제된 내용을 다시 캡처하면 새 행 생성 (KNOWN GAP) |
| 동시성 | fork heal (8회 재시도, 큰 new-id 승리, `may_collapse` 게이트) | 없음 (수면 통합은 단일 cron 실행 — 동시성 경합이 구조적으로 적음) |

## 2. dedup 흡수 — 임계값 비교

memora (`storage.py`):
- `_ABSORB_DUPLICATE_THRESHOLD = 0.85` — 이 이상이면 LLM 호출 없이 `skipped`
  (주석: "No-LLM auto-skip: must be very high confidence").
- `_ABSORB_RELATED_THRESHOLD = 0.35` — 이 이상이면 LLM 분류로 보냄
  (duplicate / supersede / related / contradicts / neither 중 판정).
- `_ABSORB_CONSOLIDATION_THRESHOLD = 0.55` — 새로 들어온 사실끼리 묶는 기준.
- `DUPLICATE_THRESHOLD = 0.85` — `find_duplicate_pairs`의 정식 중복 기준.
  단, 점수 ≥ 0.9999는 absorb가 찍은 "연결됐지만 중복 아님" 링크이므로 제외한다
  (코사인 유사도는 1.0 미만이 수학적으로 보장된다는 점을 이용한 구분).
- 같은 내용 재흡수는 live leaf 기준으로만 본다: retired(삭제·tombstone)된
  매치는 후보에서 먼저 제외한다 (`_retired_ids_among`).

MyHub:
- `captureFacts`는 활성 200개의 `normalizeForDuplicate` 집합과 **완전 일치**만
  비교한다. 임계값이 없어 "말만 바꾼" near-duplicate는 그대로 저장된다.
- 이번 트랙 테스트로 고정한 동작 (`svc-memory-temporal-edges.test.ts`):
  활성 중복은 스킵, **대체된 사실과 같은 내용은 새 행으로 생성**된다
  (memora와 동일 — live leaf만 dedup 대상).
- **차이 (KNOWN GAP)**: memora의 0.35~0.85 구간(애매한 유사도)은 LLM이
  판정하지만, MyHub는 그 구간이 통째로 없다. 패러프레이즈 중복이 쌓이면
  수면 통합의 `findDuplicateGroups`도 못 잡는다. 다음 단계 후보:
  FTS 토큰 교집합 기반 near-duplicate 후보 + 모순 판정과 같은 결정적
  임계값(예: 교집합/짧은 쪽 ≥ 0.8이면 병합 후보) — 임베딩 없이 갈 수 있는
  선에서 먼저 할 것.

## 3. supersession 계보 — 체인·분기·게이트

memora (`storage.py`):
- 후보: `_SUPERSESSION_CANDIDATE_THRESHOLD = 0.55`로 `find_duplicate_candidates`
  재사용 + 이미 간선이 있는 쌍 제외. 신·구는 `created_at` → id 순으로 정한다.
- 판정: `detect_supersessions`는 LLM에 A/B 중립 제시로 분류하고
  (`a_supersedes_b` / `b_supersedes_a` / `duplicate` / `related` /
  `contradicts` / `neither`), `min_confidence = 0.75` 미만이면 기각.
  기본 `dry_run=True` — 간선 생성을 기본으로 하지 않는다.
- 게이트 (`_absorb_check_supersede`): ① **타입 경계 우선** — 새 사실의 타입과
  리프의 타입이 다르면 LLM 호출 없이 `related`로 강등한다
  ("a supersession never crosses types" — 일반 서술이 열린 todo를
  대체했던 실제 이슈 #1126의 회귀 방지). ② 유사도 하한
  `_ABSORB_SUPERSEDE_MIN_SCORE = 0.55` 미만이면 LLM 없이 기각.
  ③ LLM 검증 — 불확실하거나 실패하면 **절대 대체하지 않는다** (fail-closed).
- 쓰기 경계 재검증: 분류 후 쓰기 직전에 타겟을 **live leaf로 다시 해소**하고,
  그 사이 리프가 편집됐거나 타입이 바뀌었으면 **게이트를 다시** 돈다
  (`_resolve_absorb_supersedes_target`, `test_leaf_edited_between_gate_and_write_is_regated_on_new_text`).
- 체인: `_walk_chain`은 BFS로 모든 분기를 수집하고 visited 집합 + 최대
  깊이로 사이클을 막는다. `_resolve_latest`는 리프 목록을 반환하고,
  리프가 없으면(사이클) max(id)를 결정적 폴백으로 반환한다.
- 읽기: list/search는 대체된 기억을 숨기고, get은 현재 리프로 해소한다.
- fork heal (`_heal_supersession_fork`, 최대 8회 재시도): 동시에 두 absorb가
  같은 리프를 대체하면 큰 new-id가 승리하고 패자는 재시도한다.
  단 `may_collapse` 게이트가 막으면 **의도된 fork로 둘 다 살려둔다**
  (게이트를 통과하지 않은 쌍은 억지로 합치지 않는다).

MyHub:
- `supersedeMemory`는 직접 포인터 2개(`superseded_by`/`supersedes`)만 쓴다.
  간선 테이블이 없어 체인 조회는 포인터를 따라가야 한다.
- 이번 트랙에서 `resolveSupersedeLeaf`를 추가했다 — memora의
  `_walk_chain`/`_resolve_latest`와 동일 규칙 (선형 체인 → 리프,
  사이클 → 방문 집합 중 max(id), 끊긴 포인터 → 끊긴 지점이 리프).
  테스트에 선형·단일·없음·사이클·끊김 5건을 넣었다.
- **차이 (KNOWN GAP)**:
  1. 타입 경계 없음 — MyHub 사실은 전부 `category='fact'`라 지금은
     충돌할 타입이 없지만, 카테고리가 늘면(memora 이슈 #1126과 같은)
     사고가 날 수 있다. 카테고리 확장 시 게이트를 먼저 넣을 것.
  2. 쓰기 경계 재검증 없음 — 수면 통합은 단일 실행이라 동시성 경합이
     적지만, 수동 supersede API와 통합이 겹치면 stale 타겟을 대체할 수
     있다. (memora는 이걸 테스트로 고정해 둠.)
  3. fork heal 없음 — 복원 후 분기가 생기면(아래 4절) 해소 로직이 없다.
     의도된 fork로 두는 것까지는 memora와 같지만, "둘 다 살려둔다"는
     결정이 명시적이지 않고 검색 랭킹에 맡겨져 있다.

## 4. "대체됐는데 다시 살아나는" 경우 — 가장 큰 차이

memora:
- **제자리 복원은 없다.** 대체된 기억을 되살리는 API·경로가 없다.
  옛 내용이 다시 필요하면 **새 행으로 absorb**되고, 그 새 행이 현재
  리프를 대체한다 (옛 행은 대체된 채로 계보에 남는다 — 부활이 아니라
  계보의 전진이다).
- **삭제는 tombstone으로 봉인한다.** `delete_memory`는 콘텐츠 해시
  (공백 축소 + casefold 후 sha256)를 `tombstone_components`에 남기고,
  absorb/import는 그 해시를 조회해 **삭제된 내용을 다시 만들지 못하게**
  막는다 (`action: "tombstoned"`). 쓰기 경계에서도 분류 이후 tombstone된
  컴포넌트는 방금 만든 행을 보상 삭제(compensating delete)한다
  ("deletion wins" — 삭제가 absorb보다 이긴다).

MyHub (이번 트랙 이후):
- `restoreMemory`가 **제자리 복원**을 한다 (`is_active=1`,
  `superseded_by=NULL`). 이번 트랙에서 복원 시 닫혔던 시간 엣지도 다시
  연다 (`reopenFactTemporalEdges` — `valid_until=NULL`, `valid_from` 유지).
- **문제**: 대체자도 살아 있는 상태에서 복원하면 **두 버전이 동시에
  유효한 분기(fork)** 가 된다. memora의 fork heal처럼 해소 로직이 없어
  검색은 융합 랭킹(최신성·접근)에 맡긴다. 사용자가 명시적으로 복원한
  것이므로 의도는 분명하지만, "어느 버전이 현재 진실인가"가
  모호해진다. 다음 단계 후보: 복원 시 대체자에게 모순 플래그를 달거나,
  복원 사유를 `memory_consolidation_log`에 남기는 것.
- **삭제 후 재흡수 (KNOWN GAP)**: MyHub는 메모·기억 삭제 시 tombstone을
  남기지 않는다. 삭제된 사실과 같은 내용을 다시 캡처하면 새 행이
  생성된다 (이번 트랙 테스트는 **대체된** 내용의 재흡수만 고정했고,
  삭제된 내용의 재흡수는 막지 않는다). memora의 tombstone 해시 패턴을
  차용하려면 삭제 경로에 해시 테이블이 필요하고, "삭제한 걸 사용자가
  다시 저장하는 게 당연한 경우"와의 정책 결정이 먼저다 — 이번 범위 밖.

## 5. Graphiti 시간축 — memora에는 없고 MyHub에 새로 생긴 것

- memora의 간선에는 유효 기간이 없다. "언제"가 바뀌면 새 행이 리프가
  될 뿐, 옛 간선이 언제까지 유효했는지는 남지 않는다.
- MyHub 0056 (`memory_fact_entities.valid_from`·`valid_until`):
  새 사실이 오면 기존 사실의 연결을 닫는다 (수면 통합 병합 +
  `POST /:id/supersede`, `closeFactTemporalEdges` — 열린 연결만 닫아
  멱등). 읽기는 현재 유효한 연결만 본다 (`expandGraphFacts` /
  `getFactNeighbors`의 `fe.valid_until IS NULL`).
  복원은 다시 연다 (`reopenFactTemporalEdges`).
- 엔티티 해소 1단계로 `normalizeEntityName`에 조사 제거를 넣었다
  ("아내는/아내가/아내를" → "아내"). KNOWN LIMITATION: 이름 자체가
  조사 글자로 끝나면 과도 제거된다 ("보라돌이" → "보라돌").
  같은 입력은 항상 같은 normalized라 해소 일관성은 유지되지만,
  다른 엔티티와 충돌할 수 있다. memora는 임베딩 유사도 + LLM
  검증으로 이 문제를 피한다 — 결정적 규칙의 한계로 기록한다.

## 6. memora 테스트에서 가져온 엣지 케이스 (반영 완료)

`tests/test_absorb_supersede_gate.py`의 케이스를 MyHub 테스트로 옮겼다
(`tests/unit/svc-memory-temporal-edges.test.ts`, 괄호 안은 memora 원본):

| memora 케이스 | MyHub 반영 |
|---|---|
| 동일 사실 재흡수 (`skipped`, duplicate 0.85) | `captureFacts` 활성 중복 스킵 + 대체된 내용 재흡수는 새 행 생성 |
| 대체 체인 (`_resolve_latest`, 리프 해소) | `resolveSupersedeLeaf` 선형·단일·없음·사이클·끊김 5건 |
| 복원 (memora에는 없는 동작 — 대조용) | 시간 엣지 닫기 → 다시 열기, `valid_from` 유지, 닫기 멱등 |
| stale 타겟 해소 (분류 후 리프가 바뀜) | **미반영** — 3절 KNOWN GAP 2번 (쓰기 경계 재검증 없음) |
| 타입 경계 (plain ↔ todo 대체 금지) | **미반영** — 3절 KNOWN GAP 1번 (카테고리 확장 시 게이트 필요) |
| fork heal (동시 대체 충돌 해소) | **미반영** — 3절 KNOWN GAP 3번 (단일 cron 실행이라 당장 경합 적음) |
| tombstone (삭제 후 재흡수 차단) | **미반영** — 4절 KNOWN GAP (정책 결정 선행 필요) |

## 7. 결론 — 가져올 것 / 가져오지 않을 것

**가져온 것 (이번 트랙)**:
- 시간 엣지 (`valid_from`·`valid_until` + 닫기 규칙) — Graphiti 패턴.
- 체인 해소 순수 함수 (`resolveSupersedeLeaf`) — memora `_resolve_latest` 규칙.
- 엔티티 정규화에 조사 제거 — Graphiti 해소 1단계.
- 엣지 케이스 테스트 (재흡수·체인·복원) — memora 게이트 테스트 대조.

**가져오지 않은 것 (의도적)**:
- memora의 임베딩 코사인 dedup (0.85/0.35/0.55) — 임베딩 인프라 없음.
  결정적 규칙으로 갈 수 있는 선(FTS 토큰 교집합 임계값)까지만 다음 단계로.
- LLM supersede 검증 (신뢰도 0.75) — MyHub 통합은 zero-LLM이 원칙.
- tombstone — 삭제 정책 결정이 선행돼야 함.
- fork heal — 동시성 경합이 구조적으로 적은 지금은 과잉.

**다음 단계 후보 (우선순위순)**:
1. FTS 토큰 교집합 기반 near-duplicate 후보 임계값 (2절 GAP).
2. 복원 시 대체자 모순 플래그 또는 복원 사유 감사 로그 (4절).
3. 카테고리 확장 시 타입 경계 게이트 (3절 GAP 1).
4. 삭제 tombstone 해시 — 정책 결정 후 (4절 GAP).
