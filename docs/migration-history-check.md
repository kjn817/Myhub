# 운영 D1 `d1_migrations` 조회 오류 규명 + 마이그레이션 적용 판정 절차

- 작성: 2026-10-29 (조사 트랙 `p0/mig-history-doc`, 기준 커밋 269dfe1)
- 대상: 운영 D1 `myhub-db` (ID `0dd871c5-3d1c-4cea-bfbe-3e258f477106`)
- 조회 경로: `.scratch/d1q.py` — Cloudflare D1 REST API
  `POST /accounts/{acct}/d1/database/{db}/query`, 서로게이트 인증 (`custom.cloudflare`)
- 이 문서의 모든 판정은 2026-10-29 운영 D1 읽기 전용(SELECT류) 실측에 근거한다. 운영 D1 쓰기는 하지 않았다.

---

## 1. 확정된 원인

**`d1_migrations` 테이블이 운영 D1에 존재하지 않는다.** 조회 실패는 API·인증·SQL 형태의
문제가 아니라, 조회 대상 자체가 없는 것이다.

왜 없는가: `d1_migrations`는 **wrangler 마이그레이션 시스템이 만들고 유지하는 기록
테이블**이다. Cloudflare 공식 문서 (D1 Migrations): "Creating migrations will keep a
record of applied migrations in the `d1_migrations` table found in your database."
즉 이 테이블은 `wrangler d1 migrations create/apply` 흐름을 쓸 때만 생성·기록된다.

MyHub 운영 적용 흐름은 wrangler 마이그레이션을 쓰지 않는다:

- 운영 규칙상 마이그레이션은 **지정 파일 단독**으로 D1 REST API를 통해 적용한다
  (`.scratch/apply_migration_one.py` — 파일을 문장 단위로 나눠 `/query`로 실행만 하고,
  어떤 이력 테이블도 만들거나 기록하지 않는다. 구 `.scratch/apply_migrations.py`도 동일).
- `wrangler.toml`의 D1 바인딩에도 `migrations_table`/`migrations_dir` 커스터마이즈가 없다.
- 저장소 전체에 `d1_migrations`를 참조하는 코드·문서가 없었다 (본 조사 시점 grep 0건).

따라서 적용 이력은 애초에 어디에도 기록된 적이 없고, 조회가 실패하는 것이 정상 동작이다.

### 1.1 실측 증거 (2026-10-29, 원시 응답)

지시된 4개 쿼리:

| # | 쿼리 | 결과 |
|---|------|------|
| Q1 | `SELECT * FROM d1_migrations LIMIT 5` | **HTTP 400** `{"success":false,"errors":[{"code":7500,"message":"no such table: d1_migrations: SQLITE_ERROR"}],"result":[]}` |
| Q2 | `SELECT name FROM sqlite_master WHERE name LIKE '%migration%'` | HTTP 200, 결과 **0행** — 이름에 migration이 들어가는 객체가 DB에 없음 |
| Q3 | `SELECT sql FROM sqlite_master WHERE name='d1_migrations'` | HTTP 200, 결과 **0행** |
| Q4 | `PRAGMA table_info(d1_migrations)` | HTTP 200, 결과 **0행** (SQLite 의미론: 없는 테이블의 `table_info`는 오류가 아니라 빈 결과) |

가설 판정을 위한 추가 대조 쿼리:

| 쿼리 | 결과 | 판정 근거 |
|------|------|-----------|
| `SELECT COUNT(*) FROM d1_migrations` / `SELECT id, name, applied_at ...` / `SELECT name ...` / 말미 `;` 포함 | 전부 Q1과 **동일한 400·code 7500** | `SELECT *` 등 특정 SQL 형태의 문제가 아님 (가설 ② 기각) |
| `/raw` 엔드포인트로 같은 쿼리 | 동일한 400 | 엔드포인트 무관 |
| `SELECT name FROM sqlite_master WHERE type='table' AND name='memos'` | 200, `memos` 반환 | 같은 세션·같은 인증으로 스키마 조회 정상 (가설 ③ 기각) |
| `PRAGMA table_info(memos)` | 200, 컬럼 6개 반환 | PRAGMA 자체는 이 경로에서 동작 |
| `SELECT COUNT(*) FROM sqlite_master WHERE type='table'` | 200, **78개 테이블** | DB·경로 전반은 정상 |
| `SELECT type, name FROM sqlite_master WHERE name LIKE 'd1%' OR name LIKE '\_cf%'` | `_cf_KV`만 존재 | 대체 이력 테이블 없음. 내부 객체는 `_cf_KV`·`sqlite_sequence`뿐 |
| `PRAGMA database_list` | HTTP 400, code 7500, `not authorized: SQLITE_AUTH` | 일부 PRAGMA는 D1 authorizer가 차단 — 단, 이것은 `d1_migrations` 건과 무관한 별개 제약 (§4) |

### 1.2 왜 그동안 "조회 오류"로만 남아 있었나

`.scratch/d1q.py`는 `urllib.error.HTTPError`를 잡지 않는다. 그래서 400 응답이
`urllib.error.HTTPError: HTTP Error 400: Bad Request` 트레이스백으로만 표면화되고,
**오류 본문(`no such table: d1_migrations`)이 버려졌다.** 본문이 처음부터 보였으면
원인은 즉시 확정됐을 것이다. 오류 본문을 보려면 `d1w.py`처럼 HTTPError를 잡아
`e.read()`를 출력하는 실행기를 쓸 것.

---

## 2. 이력 조회 가능 여부

**불가능하다 — 확정.** 어떤 쿼리 형태로도 읽을 수 없다. 이유는 단순하다:
읽을 기록이 존재하지 않는다. `d1_migrations` 테이블이 없고, 다른 이름의 이력
테이블도 없으며 (Q2·G1 실측), 적용 스크립트가 파일·로그 외에 DB 안에 흔적을
남기지 않는다.

- 현존하는 유일한 "이력"은 간접 기록뿐이다: 저장소 `migrations/` 파일 집합,
  `.scratch/snapshot_*.json` 스냅샷, 작업 기록(메모리·커밋). 이는 "무엇을 적용하려
  했는가"이지 "무엇이 실제로 적용됐는가"의 증거가 아니다.
- **적용 여부의 판정은 §3의 스키마 실물 대조로만 한다.** 이것이 지금까지
  0044·0060·0061 판정에 실제로 써 온 방식이며, 이력 테이블이 없는 현 구조에서는
  가장 강한 증거다 (기록은 누락·위조될 수 있어도 스키마 실물은 현재 상태를 그대로 보여준다).
- (결정 사항, 이 문서의 범위 밖) 과거 이력을 소급해 `d1_migrations`를 만들어 채우는
  것은 운영 D1 **쓰기**이므로 이 조사에서는 하지 않았다. 앞으로도 하지 않는 것을
  권한다: 소급 기록은 실물 대조로 판정한 것만 채울 수 있는데, 그 판정 자체가 이미
  §3 절차로 충분하고, 반쪽짜리 이력 테이블이 생기면 "이력에 없음 = 미적용"이라는
  잘못된 추론을 유발한다.

---

## 3. 대안 절차 — 스키마 실물 대조 체크리스트

마이그레이션 적용 판정은 아래 패턴으로 한다. 전부 읽기 전용이며 `.scratch/d1q.py`
(또는 오류 본문을 잡는 실행기)로 실행한다. **판정 원칙: 마이그레이션이 만드는
객체·컬럼·DDL 특징이 라이브 스키마에 있으면 적용, 없으면 미적용.** 행 수는
"적용 과정에서 기존 데이터가 보존됐는가"의 확인용이지 적용 판정 자체가 아니다.

### 3.1 쿼리 모음

```sql
-- (a) 테이블/인덱스/트리거/뷰 존재 확인 (타입 포함)
SELECT type, name FROM sqlite_master
WHERE name IN ('<객체1>', '<객체2>') OR tbl_name IN ('<객체1>', '<객체2>')
ORDER BY name;

-- (b) 테이블 DDL 전문 — FTS 형태·제약·기본값 등 "특징" 판정용
SELECT sql FROM sqlite_master WHERE name = '<테이블명>';

-- (c) 컬럼 존재·순서·타입 확인 (ADD COLUMN 판정용)
PRAGMA table_info(<테이블명>);

-- (d) 인덱스 목록 확인
SELECT type, name FROM sqlite_master
WHERE type = 'index' AND tbl_name = '<테이블명>';

-- (e) 트리거 DDL 확인 (본문의 DELETE 패턴 등 판정용)
SELECT name, sql FROM sqlite_master
WHERE type = 'trigger' AND tbl_name = '<테이블명>';

-- (f) 데이터 보존 확인 (적용 전후 비교)
SELECT COUNT(*) FROM <기존 테이블>;
```

주의: `PRAGMA table_info(없는 테이블)`은 오류가 아니라 **빈 결과**를 돌려준다 (§1.1 Q4).
PRAGMA 단독으로 존재 판정을 하지 말고 반드시 (a)와 교차 확인할 것.

### 3.2 실제 판정 사례 (전부 위 패턴으로 확정됨)

**0044 (`0044_memory_pages_aging.sql`) — 적용됨**
- 적용 전 (2026-10-25, `docs/ops/apply-0044-prep.md`): (a)로 `memory_pages`·
  `memory_handoffs` 없음 → 미적용 확인 후 적용.
- 적용 후·재판정 (2026-10-29 본 조사에서도 재확인): (a) 두 테이블 존재,
  (c) `ai_memory_v2`에 `access_count`·`superseded_by` 등 신규 컬럼 존재,
  (b) `ai_memory_fts` DDL이 `CREATE VIRTUAL TABLE ai_memory_fts USING fts5(content)`
  — 일반 FTS5이고 구 0028의 `content=` 외부 콘텐츠 형태가 아님.

**0060 (`0060_mcp_tokens.sql`) — 적용됨**
- (a)+(d): `mcp_tokens` 테이블 + 인덱스 `idx_mcp_tokens_email`·`idx_mcp_tokens_hash` 존재.
- (f): `memos` 28행 불변 (기존 데이터 보존).

**0061 (`0061_mcp_tasks.sql`) — 적용됨**
- (a)+(d): `mcp_tasks` 테이블 + 인덱스 `idx_mcp_tasks_email_created` 존재
  (2026-10-29 본 조사에서 재확인).
- (f): `memos` 28·`schedules` 12·`todos` 5행 불변.

---

## 4. 영향 범위 — d1q 경로 전반의 확인된 제약

`d1_migrations` 부재는 이 테이블 하나에 국한된 사실이며, 다른 관리 조회 경로의
장애가 아니다. 경로 전반에 대해 실측으로 확인된 것은 다음과 같다.

| 항목 | 상태 | 근거 |
|------|------|------|
| `sqlite_master` 조회 (스키마 감사·판정) | ✅ 정상 | Q2·Q3·(a)~(e) 전부 200 |
| `PRAGMA table_info / index_list / foreign_key_list` | ✅ 정상 | `table_info(memos)` 컬럼 반환, 나머지 200 |
| `PRAGMA database_list` 등 일부 PRAGMA | ❌ 400 `not authorized: SQLITE_AUTH` (code 7500) | D1 authorizer 차단. 스키마 판정에는 불필요 |
| 다중 문장 (`SELECT 1; SELECT 2`) | ✅ `/query`는 문장별 결과를 배열로 반환 | 실측 200. 단 적용 스크립트는 실패 지점 특정 때문에 문장 단위 분할 실행을 유지한다 |
| SQL 오류 시 응답 | HTTP 400 + `success:false` + `errors:[{code:7500, message}]`, `result:[]` | `d1q.py`는 이를 잡지 못해 본문이 유실됨 (§1.2) |
| Time Travel bookmark (백업) | `d1_migrations`와 무관한 별개 REST 경로 (`/time_travel`). 과거 시도에서 404 Route not found를 기록한 바 있어 스냅샷 방식으로 대체해 왔다 (`.scratch/snapshot_0059_pre.json`의 `bookmark` 필드) | 본 조사에서 재시도하지 않음 — 미확인 사항 (§6) |

결론: 백업·감사에 필요한 스키마/행수 조회는 현 경로로 전부 가능하다.
이력이 없다는 것 외에, 이 오류가 다른 관리 기능을 막는 부분은 확인되지 않았다.

---

## 5. 향후 마이그레이션 적용 시 기록 절차

이력 테이블이 없으므로, **적용 기록은 파일로 남기는 것이 유일한 이력**이다.
기존 `.scratch/apply_migration_one.py` 흐름에 아래를 붙인다 (0058·0059에서 실제로
쓴 스냅샷 방식의 정식화).

1. **적용 전**
   - Time Travel bookmark 확보를 먼저 시도한다 (`.scratch/bookmark.py`).
     실패하면 중단이 원칙이나, 404 전례가 있으므로 그 경우 아래 스냅샷으로 대체하고
     스냅샷 파일에 bookmark 실패 사실과 원문을 기록한다 (0059 전례 형식).
   - 스냅샷 저장: `.scratch/snapshot_<번호>_pre.json`
     - 주요 기존 테이블 행 수 (`memos`, `schedules`, `todos` 등 영향권 + 전체 테이블 수)
     - §3.1 (a)로 "이 마이그레이션이 만들 객체가 아직 없음"을 확인한 결과
     - DB 크기 (`/query` 응답의 `meta.size_after` 또는 별도 조회)
2. **적용**
   - 지정 파일만 단독 적용: `python3 .scratch/apply_migration_one.py migrations/<파일>`
     (일괄 적용 금지, 실패 문장에서 중단되는 기존 동작 유지)
3. **적용 후**
   - 스냅샷 저장: `.scratch/snapshot_<번호>_post.json`
     - §3.1 (a)~(e)로 신규 객체·컬럼·인덱스·트리거 실물 확인 결과
     - (f) 기존 테이블 행 수 불변 확인
     - 기능 마이그레이션은 대표 쿼리 실동작 1건 (예: 0059의 trigram 프로브)
   - 작업 기록(메모리)에 "마이그레이션 <번호> 운영 적용 완료 — 판정 근거: <객체 목록>"
     형태로 남긴다. 이것이 사실상 적용 대장이다.
4. **금지**: 이력을 만들 목적만으로 `d1_migrations`를 만들거나 채우지 않는다 (§2).

---

## 6. 남은 미확인 사항

- Time Travel bookmark 엔드포인트의 현재 상태: 과거 404 기록만 있고 본 조사에서는
  재시도하지 않았다 (쓰기와 무관한 GET이지만, 이 트랙 범위를 "d1_migrations 규명"으로
  한정했다). 백업 절차를 다듬을 때 별도 확인이 필요하다.
- 스테이징 D1 (`myhub-db-staging`)에 `d1_migrations`가 있는지는 확인하지 않았다
  (운영 판정과 무관하고, 실무에서 스테이징은 사용하지 않는다).
- Cloudflare 대시보드 콘솔 등 다른 클라이언트에서의 조회는 시도하지 않았다 —
  단, 테이블 부재는 클라이언트와 무관한 DB 상태이므로 결과는 동일하다.
