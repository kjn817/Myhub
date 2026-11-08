# security-audit 스킬 — MyHub 적용 어댑터

> 원본 스킬: Cloudflare `cloudflare/security-audit-skill` (MIT, 커밋
> `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, 2026-09-14).
> 이 디렉터리의 `SKILL.md` 등 원본 파일은 수정하지 않는다. MyHub에 맞춘
> 매핑·제약은 이 파일에만 둔다. 원본 README는 `UPSTREAM-README.md`,
> 라이선스는 `LICENSE` 참조.

## 1. 플랫폼 용어 매핑 (원본 SKILL.md "Platform terminology")

| 원본 용어 | MyHub에서의 대응 |
|---|---|
| Parent (조정 에이전트) | Muse 메인 에이전트 (감사 실행을 지시한 주체) |
| Task tool / sub-agent | `subagent.spawn`으로 띄우는 서브에이전트 (depth 1 유지, 서브가 서브를 호출하지 않음) |
| `research` agent | 읽기·검증 전용 서브에이전트 |
| `general` agent | 제한된 로컬 실행(테스트 등)을 수행하는 서브에이전트 |
| Output directory | `docs/security-audit/runs/run-<NNN>/` (저장소 내부 — 아래 2절 참조) |

## 2. 산출물 위치 (원본 기본값과의 차이)

원본 기본값은 저장소 밖 `~/security-audit-skill/<repo>/run-<N>`이다.
MyHub는 감사 산출물을 QA 증거로 저장소에 남기는 것이 목적이므로,
**사용자(부모 에이전트)가 저장소 내 위치를 명시 선택**한 것으로 간주하고
`docs/security-audit/runs/run-<NNN>/`에 둔다. 사용법은
`docs/security-audit/README.md` 참조.

산출물(원본과 동일): `run-metadata.json`, `architecture.md`,
`coverage-ledger.json`, `findings.json`, `REPORT.md`,
`FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`.

## 3. MyHub 보안·QA 원칙 (원본 "Core principles" 위에 적용)

- **PASS는 실제 실행 증거에만.** 테스트하지 않은 항목은 NOT TESTED로
  표기한다. 감사 결과의 `confirmed`도 로컬에서 재현된 최소 경계
  효과(잘못된 반환값, 무권한 더미 레코드 접근 등)가 있어야 한다.
- **P0/P1 판정 기준.** P0/P1에 해당하는 `confirmed`가 남아 있으면
  운영 배포는 NO-GO다. 감사 보고서는 P0/P1 여부를 명시한다.
- **잠긴 메모·비밀정보는 감사 과정에서도 외부 전송 금지.**
  잠긴 메모, `MEMO_ENCRYPTION_KEY` 등 Worker Secret 값, OTP 코드,
  세션 토큰, API 키는 감사 산출물·헌터/검증자 프롬프트·로그에
  포함하지 않는다. 감사에 필요한 값은 더미(dummy) 값만 사용한다.
- **읽기 전용.** 감사는 소스 코드를 변경하지 않는다. 수정 제안은
  `findings.json`의 `remediation`에만 적는다.
- **운영 금지.** 운영 D1, 운영 Worker, 라이브 엔드포인트, 실제
  이메일 발송, 유료 API 호출을 감사에 사용하지 않는다. 검증은
  로컬 Jest 테스트·정적 추적·더미 데이터로만 수행한다.

## 4. 실행 경계 (원본 "Universal execution safety"의 MyHub 구현)

- 네트워크 없음: 로컬 테스트만 실행한다 (`npm test` / `npx jest`).
  `wrangler dev`, 라이브 fetch, 외부 API 호출 금지.
- 대상 코드 실행은 Jest 테스트 형태로만 하며, 더미 이메일·더미
  PIN·더미 세션 시크릿을 사용한다.
- 산출물 승격(promotion) 절차는 원본대로 부모 에이전트만 수행한다.
  헌터·검증자 서브에이전트는 산출물을 직접 쓰지 않고 결과를
  부모에게 반환한다.

## 5. MyHub 아키텍처 요약 (감사 스코프 기준)

- 스택: Cloudflare Workers + Hono + D1 + KV, TypeScript, Jest.
- 인증: 이메일 OTP(1일 1코드, 당일 재사용) → 세션(HMAC-SHA256 서명,
  HttpOnly·Secure·SameSite=Lax 쿠키, 30일) → PIN 6자리
  (PBKDF2-SHA256 100k, 실패 5회 시 KV 카운터로 15분 잠금).
  PIN 설정/재발급은 유효 세션 필수, UPSERT라 재발급 즉시 기존 PIN 무효.
- 단일 사용자 전용 시스템. 허용 이메일은 환경별 allowlist로 관리하고
  설정 누락 시 fail-closed.
- 주요 신뢰 경계: 미인증 HTTP 요청 → 인증 미들웨어(`src/index.ts`)
  → 모듈 라우트 → D1/KV. 잠긴 메모는 AI 접근 계층에서 원천 차단.

## 6. 감사 프로파일 선택 기준

- `quick`: 단일 모듈 시범 감사, 재감사, 빠른 첫 확인. (시범 run-001이 해당)
- `standard`: 모듈 단위 정기 감사(QA 게이트).
- `deep`: 출시 전 전수 감사.
- 스코프는 `run-metadata.json`의 `scope_paths`에 명시하고,
  스코프 밖은 `out_of_scope`로 ledger에 남긴다 (covered로 속이지 않음).

## 7. QA 게이트 연동

- 감사 실행 시점: 기능 개발 완료 후 운영 배포 전, 또는 정기 점검.
- `confirmed` 중 P0/P1이 있으면 배포 NO-GO, 수정 후 재감사.
- `needs_validation`은 배포 전 소유자 확인이 필요함을 명시한다.
- 재감사는 이전 run의 `coverage-ledger.json`/`findings.json`을
  읽어 변경된 소스 재검증·미해결 항목을 현재 작업으로 삼는다.
