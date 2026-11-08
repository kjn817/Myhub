# 민감 데이터 접근 경로 검증 — 트랙 A: 읽기 경로 (2026-10-30)

- 담당: 트랙 A 워커 (읽기 경로 전수)
- 기준 정책 (변경 대상 아님): 잠긴 메모는 모든 외부 AI 전송 경로에서 제외. 소유자 세션 읽기는 허용 (단건 GET 소유자 복호화가 현 정책). 잠금 해제는 PIN step-up 필수.
- 검증 대상 코드: 브랜치 `fix/unlock-block-remove-ciphertext` 작업 트리 / 운영 라이브 `d568a5b8` @100%
- 경로 표기: 실제 마운트는 모듈 id 기준 **`/api/memo`** (단수)이다. 과제 문서의 `/api/memos`는 이 경로를 가리킨다 (프론트 `public/js/memo/*`도 `/api/memo` 사용 확인).
- 라이브 프로브: `.scratch/readpath_probe.py` (OTP 로그인 → 일회용 메모 id 227 생성·잠금·검증 → DELETE로 정리 완료, 파일 행 포함 삭제 확인). 기존 잠긴 메모(133·134·200·201)는 본문을 열지 않고 잠금 상태·`substr(text,1,4)` 접두사·FTS 존재 여부까지만 확인했다.

## 경로별 결과

| # | 경로 | 기대 정책 | 실증 방법 | 결과 |
|---|------|-----------|-----------|------|
| A1 | `GET /api/memo/:id` (단건) | 소유자 세션: 잠긴 메모 복호화 반환 (현 정책), 원시 ENC: 노출 금지, 복호화 실패 시 플레이스홀더. 무인증 401, 없는 id 404, 잘못된 id 400 | 런타임 기존 스위트(`memo-lock-encryption` #6·#6b) + 신규 #7 / 라이브: 무인증 401, 일회용 잠금 메모 소유자 조회 시 평문 반환·ENC: 부재 | **PASS** |
| A2 | `GET /api/memo` (무검색 목록) | 소유자: 잠긴 메모 복호화 반환, ENC: 원시 노출 금지 | 런타임 기존 #6·#6b / 라이브: 일회용 잠금 메모가 목록에서 평문으로, 응답 전체에 ENC: 부재 | **PASS** |
| A3 | `GET /api/memo?q=` FTS 단계 (memos_fts) | 잠긴·sensitivity≥2 메모 미반환 | 런타임 신규 #1·#2·#3 / 라이브: 토큰 검색에서 일회용 잠금 메모 미반환 | **PASS** |
| A4 | `GET /api/memo?q=` trigram 단계 (memos_fts_tri) | 동상 | 런타임 신규 #1·#2·#3 / 라이브 간접(부분 검색 포함) | **PASS** |
| A5 | `GET /api/memo?q=` **파일명 검색 단계** | 잠긴·기밀 메모는 파일명이 일치해도 본문이 실리지 않아야 함 (0030 경계, 4번 LIKE 단계와 동일 원칙) | 런타임 신규 #4 — **수정 전 FAIL 재현** (잠긴 메모 id가 결과에 포함) → 수정 후 PASS / 라이브: 일회용 잠금 메모 + D1 파일 행 삽입 후 파일명 토큰 검색 시 **본문 평문 누출 재현 (leaked=true)** — 라이브는 수정 전 버전이라 예상된 FAIL | **FAIL (라이브) → 수정 완료·런타임 PASS, 배포 대기** |
| A6 | `GET /api/memo?q=` 짧은 검색어 LIKE 폴백 | 잠긴·기밀 제외 (`is_locked=0 AND sensitivity<2` 필터 기존재) | 런타임 기존 FTS 스위트 + 신규 #3 (1~2글자 질의) / 라이브 `q=RPX` 미반환 | **PASS** |
| A7 | `GET /api/search` (통합 검색, unifiedSearch) | 잠긴·기밀 메모 제외 (FTS·LIKE 양쪽 필터) | 런타임 신규 #5 (실제 D1로 서비스 직접 호출) / 라이브: 토큰 검색 미반환, 무인증 401 | **PASS** |
| A8 | FTS 인덱스 자체 (memos_fts / memos_fts_tri) | 잠긴·기밀 본문 평문이 인덱스에 없어야 함. INSERT 시 제외뿐 아니라 **잠금·민감도 전이 시에도 제거**돼야 함 | 런타임 신규 #1 (잠금 전이 시 양 인덱스에서 rowid 소멸, 해제 시 복귀) · #2 (sensitivity 2 전이 시 소멸) / 라이브 D1: 기존 잠긴 4건 양 인덱스에 rowid 없음, 일회용 메모도 잠금 직후 양 인덱스 부재 | **PASS** |
| A9 | `POST /api/backup/encrypted` | 와이어 페이로드는 AES-256-GCM 암호문만. 안쪽에서도 잠긴 행은 저장 형태 그대로 ENC: | 런타임 신규 #6 (와이어에 공개·잠금 본문 모두 평문 부재 + 비밀번호로 복호화해 잠긴 행 ENC: 확인) / 라이브: 와이어 1,501,665 bytes에 일회용 비밀 토큰 부재. 단축 암호 400 확인 | **PASS** |
| A10 | `POST /api/backup` (평문 백업) | 운영에서는 403 (스테이징 전용, fail-closed) | 라이브: 인증 세션으로 `POST /api/backup` → 403 확인 (말미 슬래시 `/api/backup/`는 라우트 불일치 404 — UI는 이 경로를 쓰지 않음) | **PASS** |
| A11 | 무인증 접근 일괄 | 전 읽기 경로 401 | 라이브: `GET /api/memo`, `/api/memo/133`, `/api/memo?q=`, `/api/memo/tags`, `/api/search?q=`, `POST /api/backup/encrypted`, `POST /api/backup/` 전부 401 | **PASS** |
| A12 | 기존 잠긴 메모 저장 형태 (133·134·200·201) | 전부 is_locked=1 + ENC: 저장 | 라이브 D1 메타데이터: 4건 모두 `is_locked=1`, 접두사 `ENC:` | **PASS** |
| A13 | `GET /api/memo/stats` · `/calendar` | 건수·일자별 개수만 (본문 없음) | 코드 확인 (COUNT 집계만 반환) | **PASS** (코드) |
| A14 | `GET /api/memo/tags` | 태그는 메타데이터 — 단, 잠긴 메모 본문에서 추출된 해시태그가 남는 잔여 위험 검토 | 코드: 잠금 시 `memo_tags`를 지우지 않고, PUT(소유자 편집)은 평문 기준으로 태그를 재동기화함 (2026-10-29 기록상 "의도적 유지"로 분류된 사항). 라이브 D1: 잠긴 4건에 대한 `memo_tags` 행 **0건** — 현재 운영 데이터에서는 실제 노출 없음 (태그 값 자체는 열람하지 않음) | **PASS (현 데이터) / 잔여 위험 기록** — 태그를 단 메모를 잠그면 태그 문자열이 `/tags`와 태그 필터로 노출될 수 있다. 정책 결정 사항이라 이 트랙에서 임의로 바꾸지 않음 |
| A15 | `GET /api/memo/:id/files`, `GET /api/memo/files/:fileId`, `GET /api/memo/files/:fileId/content` | 잠긴 파일의 평문이 새지 않아야 함 | 코드 확인: 목록은 메타데이터 + 저장 URL 반환 (잠긴 파일의 URL은 암호화 blob 위치라 평문 아님). `/files/:fileId` 리다이렉트도 잠긴 파일은 암호문 blob으로 감. `/content`는 소유자 세션에서 복호화 서빙 — 해제(상태 변경)가 아니라 단건 GET과 같은 소유자 읽기 정책 범위이며 PIN step-up 대상이 아님 (unlock-block의 html 반환과는 비대칭 — 현 정책 해석 기록) | **PASS (코드)** / 라이브 실동작 **NOT TESTED** — 운영에 잠긴 파일 인스턴스 0건 (2026-10-29 기록)이라 일회용 잠금 파일을 만들려면 실제 Cloudinary 업로드·암호화 재업로드가 필요해 이 트랙 범위(운영 쓰기 최소화)를 넘어 생략 |
| A16 | MCP `memo.search` 도구 | 잠긴·민감도 2,3 제외 + 시크릿 마스킹 (외부 클라이언트 읽기 경로) | 코드 확인: 1차 `searchAccessibleMemos` 재사용 (SQL+코드 이중 필터), 2차 trigram도 `is_locked=0 AND sensitivity<=1` + `isMemoAccessibleForAI` 재검사 + `maskSecrets` | **PASS (코드)** — 런타임 실증은 MCP 스위트 소관 (기존 `tests/runtime/mcp-server.test.ts`) |
| A17 | 브리핑 읽기 경로 (`briefing/service`, `briefing-export`) | `is_locked=0 AND sensitivity<2`만 | 코드 확인: 양쪽 모두 동일 필터 명시 | **PASS (코드)** |
| A18 | 사실 캡처 (`fact-graph.captureFactsFromMemo`, `memory` capture) | 잠긴 메모는 본문을 읽지 않고 거부 | 코드 확인: is_locked 선행 쿼리로 분리해 `locked` 거부 후에만 본문 조회 | **PASS (코드)** |
| A19 | 샌드박스 미리보기 (`sandbox.ts` MEMO_UPDATE/DELETE) | 잠긴 메모 스니펫 숨김 | 코드 확인: `memoHidden` 시 `LOCKED_LABEL`로 대체 | **PASS (코드)** |

## 발견·수정한 결함

### D-A1. 파일명 검색 단계가 잠금·기밀 경계를 우회해 본문 평문을 반환 (수정 완료, 배포 대기)

- **파일**: `src/modules/memo/routes.ts` — `GET /`의 3단계(파일명 검색) SQL.
- **근본 원인**: FTS(1단계)·trigram(2단계)은 인덱스 자체가 잠긴·기밀 메모를 담지 않아 안전하고, LIKE 폴백(4단계)은 과거에 같은 우회가 발견돼 `is_locked=0 AND sensitivity<2` 필터가 들어갔지만, memos 테이블을 직접 조회하는 파일명 단계(3단계)에는 이 필터가 누락돼 있었다. 파일명만 일치하면 잠긴 메모 행이 그대로 선택되고, 소유자 경로용 `pushDecrypted`가 복호화까지 해서 검색 응답에 평문이 실렸다. sensitivity≥2(미잠금 기밀) 메모도 동일하게 노출됐다.
- **실증**: 런타임 카나리아(신규 테스트 #4)가 수정 전 실패 — 잠긴 메모 id가 결과에 포함됨. 라이브(d568a5b8)에서도 일회용 잠금 메모 + 파일 행으로 동일 누출 재현 (`leaked=true`). 주: 소유자 세션 한정 누출이라 외부 유출은 아니지만, (a) 같은 라우트의 LIKE 단계에 명문화된 경계와 모순되고, (b) 검색 응답은 AI·통합 경로와 모양이 같아 경계 혼선의 온상이 되며, (c) 기밀 메모는 잠그지 않아도 전문이 검색으로 그대로 나온다는 점에서 결함으로 판정했다.
- **수정**: 3단계 WHERE에 `AND m.is_locked = 0 AND m.sensitivity < 2` 추가 + 경계 사유 주석 (LIKE 단계 주석과 동일 원칙 명시). 공개 메모의 파일명 검색은 대조군 테스트로 회귀 없음을 확인.
- **주의 (코디네이터)**: 이 수정은 한 차례 파일에서 유실됐다가 재적용한 이력이 있다 (병렬 트랙의 동일 파일 쓰기와 경합 추정). 통합 시 `git diff`에 아래 1줄이 포함됐는지 반드시 확인할 것:
  `AND m.is_locked = 0 AND m.sensitivity < 2` (파일명 검색 단계, `src/modules/memo/routes.ts` 333행 부근)

## 추가한 테스트

- `tests/runtime/memo-read-paths-sensitive.test.ts` (신규, 7건) — miniflare 실제 D1 + 실제 AES-GCM:
  1. 잠금 전이 시 FTS·trigram 인덱스 제거/복귀
  2. 민감도(2) 전이 시 인덱스 제거
  3. 소유자 q-검색 전 단계에서 잠긴 메모 미반환 + ENC: 부재 (긴·짧은 질의)
  4. 파일명 검색 경계 (D-A1 카나리아 — 수정 전 FAIL 확인 후 수정, 이후 PASS)
  5. 통합 검색 잠금·기밀 제외
  6. 암호화 백업 와이어 평문 부재 + 내부 잠긴 행 ENC:
  7. 단건 조회 404/400 가드

## 실행 결과

| 스위트 | 결과 |
|--------|------|
| `tests/runtime/memo-read-paths-sensitive.test.ts` (신규) | 수정 전 6/7 (D-A1 카나리아 FAIL) → 수정 후 **7/7 PASS** |
| `tests/runtime/memo-search-fts.test.ts` (기존) | **13/13 PASS** |
| `tests/runtime/memo-lock-encryption.test.ts` (기존) | **21/21 PASS** |
| Jest 단위: `memo-routes` · `backup-routes` · `svc2-unified-search` · `search-routes` | **192/192 PASS** |
| 라이브 프로브 (`.scratch/readpath_probe.py` + 평문 백업 후속 확인) | 무인증 7/7 · 메타데이터 3/3 · 소유자 경로 6/6 · 백업 와이어 PASS · 평문 백업 403 PASS / 파일명 단계만 라이브 FAIL (D-A1, 수정 배포 시 해소) · 일회용 메모 정리 완료 |

## NOT TESTED / 한계

- A15 잠긴 파일 서빙의 라이브 실동작: 운영에 잠긴 파일 0건 + 생성에 실제 Cloudinary 왕복이 필요해 생략 (코드 PASS).
- `/api/memo/tags`의 태그 잔여 위험(A14): 현 운영 데이터에는 해당 없음. 태그 동기화 정책 변경은 별도 결정 사항.
- 비소유자 개념: 단일 사용자 시스템이라 "비소유 세션"은 무인증과 동일하며 A11로 갈음한다.
- 이 문서는 읽기 경로만 다룬다. 쓰기·해제·AI 전송 경로는 형제 트랙(02·03) 문서 참조.
