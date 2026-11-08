# MyHub 시스템 정보

> 현재 시스템의 스냅샷. 바뀔 때마다 여기를 갱신한다.
> 최종 갱신: 2026-10-08

## 기본

| 항목 | 값 |
|---|---|
| 서비스 URL | https://myhub.myhub-app.workers.dev |
| Worker 이름 | myhub |
| Cloudflare 계정 | kimjn00003@naver.com |
| Account ID | 59e749ed2e9cdb8b0bf70d47227968a1 |
| workers.dev 서브도메인 | myhub-app.workers.dev |
| 공개 여부 | 비공개 (이메일 OTP 인증, 2026-10-07 적용) |
| 배포 스크립트 | `~/workspace/myhub/deploy_full.py` (배포 후 자동 검증 포함) |

## 스택

- **백엔드**: Cloudflare Workers + Hono (TypeScript)
- **프론트**: 정적 HTML + 바닐라 CSS/JS (빌드 스텝 없음) → Worker에 인라인 배포
- **DB**: Cloudflare D1 (SQLite) — `myhub-db` (`0dd871c5-3d1c-4cea-bfbe-3e258f477106`)
- **파일 스토리지**: Cloudinary (무료 25GB, 카드 불필요) — 서명 업로드, Worker secret에 키 보관
- **캐시**: KV (`system:stats` 10분 캐시)
- **프로젝트 경로**: `~/workspace/myhub`

## 기반 구조 (2026-10-08 감사)

| 파일 | 역할 |
|---|---|
| `src/index.ts` | 라우팅 + 인증 미들웨어. 새 라우트는 반드시 미들웨어 뒤에 등록 |
| `src/config.ts` | 계정 ID·DB ID 등 식별자 중앙 관리 (하드코딩 금지) |
| `src/modules.ts` | 모듈 레지스트리 |
| `src/events.ts` | 모듈 간 이벤트 버스 (`on`/`emit`, `<모듈>.<동작>` 규칙) |
| `src/services/storage.ts` | 공용 파일 스토리지 (Cloudinary 어댑터) |
| `src/modules/auth/routes.ts` | 이메일 OTP 인증 (CSPRNG 코드, HMAC 세션 쿠키) |
| `public/shell.css` | 공용 스타일 (상단바 `.g-nav` — 모든 모듈 동일) |
| `public/nav.js` | 공용 스크립트 (상단바 시계, Lucide 헬퍼) |

- 엔티티 참조 규칙: `<모듈>:<id>` (예: `memo:123`)
- 메모 모듈 이벤트: `memo.created` / `memo.updated` / `memo.deleted`

## 모듈

| 모듈 | 경로 | 설명 |
|---|---|---|
| memo | `/memo.html` · `/api/memo` | 메모 v9. WYSIWYG 에디터. 표: 열 너비 드래그·행/열 추가삭제·표삭제(선택 시 검정 툴바), 너비는 `<!-- tblwidths -->`로 저장. 이미지: 드래그 이동(투명 고스트+주황 캐럿), 리사이즈·복사·삭제. 목록: 체크박스 없이 클릭 토글, 6개+페이지네이션, 달력(높이 확장). PC 3열(좌 목록｜중 팬 세로스택｜우 새메모). 디자인 v9: 흰/회/검+파스텔 블루, 각진 형태, 글로벌 내비. |

모듈 추가법: `src/modules/<이름>/routes.ts` + `public/<이름>.html` → `src/modules.ts`에 등록.
가져오기 원칙은 `CONSTITUTION.md` 제3조 참고.

## 대시보드

`public/index.html` — 벤토 그리드 업무 데스크 (v2, 2026-10-06).
인사말+시계, 빠른 메모(대시보드에서 바로 저장), 한눈에(메모/파일/이번 주 통계),
최근 메모 5개, 모듈 타일. 디자인 토큰은 헌법 제5조와 공유.

## API (memo)

- `GET /api/health`, `GET /api/modules`
- `GET /api/memo?q=` — 검색 (FTS5 → LIKE 폴백, 본문+파일명). `tag=`, `date=YYYY-MM-DD`(KST) 필터 조합 가능
- `GET /api/memo/tags` — 사용 중인 태그 목록 + 개수
- `GET /api/memo/calendar?y=&m=` — 월별 일자별 메모 수 (KST 기준)
- `POST /api/memo` — 생성 (JSON 또는 multipart)
- `PUT /api/memo/:id` — 본문 수정
- `DELETE /api/memo/:id` — 삭제 (파일도 함께)
- `GET /api/memo/stats` — 대시보드 위젯용 통계 (메모/파일/이번 주)
- `GET /api/memo/:id/files` — 파일 목록 (이미지는 thumb URL 포함)
- `POST /api/memo/:id/files` — 파일 추가
- `GET /api/memo/files/:fileId` — Cloudinary로 302 리다이렉트
- `DELETE /api/memo/files/:fileId` — 파일 삭제

## D1 스키마

- `memos(id, text, created_at)` + `memos_fts` (FTS5, 트리거로 자동 동기화)
- `memo_tags(memo_id, tag)` — 본문의 #태그 별도 저장 (생성/수정 시 서버에서 추출·동기화, 삭제 시 함께 삭제)
- `files(id, memo_id, storage_key, filename, mime, size, url, resource_type, created_at)`
  - `storage_key` = Cloudinary public_id, `url` = secure_url
- 마이그레이션: `migrations/0001_init.sql` ~ `0004_memo_tags.sql`
- D1 토큰에 D1 권한이 없어 마이그레이션은 임시 Worker 엔드포인트로 적용 후 즉시 제거 (0003, 0004 동일 방식)

## 디자인 토큰

`CONSTITUTION.md` 제5조 참고. 모든 모듈 공통 사용.
(2026-10-06 라이트 테마로 교체 — memos 분석 기반: `--bg #FAF8F5`, `--card #FFFFFF`, `--border #E9E6E0`, `--text #1F2937`)

## 테스트

- `scripts/e2e.sh` — API 전체 플로우 E2E 21항목 (생성·검색·수정·업로드·썸네일·다운로드·파일명검색·파일삭제·인라인이미지마커·마커태그필터·태그·태그필터·날짜필터·달력카운트·통계·삭제·정리확인·태그정리확인). 배포 후 실행, 전 항목 PASS 확인.
- 프론트 JS 수정 시 `node --check` 로 구문 검사 필수 (인라인 스크립트 SyntaxError가 전체 기능을 죽인 전례 있음).
- `npx tsc --noEmit` — 배포 전 타입 체크.

## 계정·자격증명

- Cloudinary: 사용자 가입 (2026-10-06), 로그인 정보는 Secure Vault에 저장
- Cloudinary API 키 3종: Worker secret (`CLOUDINARY_CLOUD_NAME` / `API_KEY` / `API_SECRET`)
- Cloudflare API 토큰: 일회성으로 발급·사용 후 폐기. 저장하지 않음.
  - 주의: "Edit Cloudflare Workers" 템플릿 토큰에는 **D1 권한이 없음**. D1 직접 조작이 필요하면 D1 권한 포함 토큰을 새로 발급하거나 임시 엔드포인트 방식 사용.

## 문서

- `CONSTITUTION.md` — 시스템 헌법 (최상위 원칙)
- `SYSTEM_INFO.md` — 이 문서
- `README.md` — 프로젝트 개요
