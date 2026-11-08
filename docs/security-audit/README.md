# MyHub 보안 감사 (security-audit 스킬)

Cloudflare 공식 보안 감사 스킬(`security-audit-skill`, MIT)을 MyHub QA
게이트에 적용한 것이다. 스킬 본체는 `skills/security-audit/`에 있고,
MyHub 맞춤 매핑·제약은 `skills/security-audit/MYHUB-ADAPTER.md`에 있다.
원본 스킬 파일은 수정하지 않는다.

## 언제 실행하는가

- 기능 개발 완료 후 운영 배포 전 (정기 QA 게이트).
- 출시 전 전수 감사.
- 보안 이슈가 의심되는 모듈의 집중 감사.
- `confirmed` 중 P0/P1이 남아 있으면 운영 배포 NO-GO.

## 어떻게 실행하는가

1. 감사 실행을 지시한다 (프로파일 + 스코프 지정).
   - `quick`: 단일 모듈 시범·재감사·빠른 확인.
   - `standard`: 모듈 단위 정기 감사.
   - `deep`: 출시 전 전수 감사.
2. 조정 에이전트(Parent)가 `docs/security-audit/runs/run-<NNN>/`를 만들고
   `run-metadata.json` → `architecture.md` → `coverage-ledger.json`
   순서로 시드한 뒤, 헌터·검증자 서브에이전트를 단계별로 투입한다.
3. 검증이 끝난 기록만 `findings.json`에 쓰고, 두 검증기로 검증한다.
   ```sh
   node skills/security-audit/validate-findings.cjs docs/security-audit/runs/run-001/findings.json
   node skills/security-audit/validate-coverage-ledger.cjs docs/security-audit/runs/run-001/coverage-ledger.json
   ```
4. 검증 통과 후 `REPORT.md`, `FINDINGS-DETAIL.md`,
   `NEEDS-VALIDATION.md`를 산출한다.

## 판정 기준

| 판정 | 의미 |
|---|---|
| `confirmed` | 소스 추적 + 로컬에서 재현된 최소 경계 효과가 있음. severity 부여. |
| `needs_validation` | 소스 근거는 있으나 결정적 사실이 배포·런타임 확인 필요. severity 없음. |
| `rejected` | 검증 과정에서 반증됨. 이후 run에서 같은 주장 반복 방지용으로 보관. |

- PASS는 실제 실행 증거에만 쓴다. 테스트하지 않은 항목은 NOT TESTED.
- `confirmed`의 severity는 입증된 impact를 초과할 수 없다.
- 감사는 읽기 전용이다. 코드 수정은 하지 않고, 수정 방향은
  `findings.json`의 `remediation`에만 적는다.
- 잠긴 메모·Worker Secret 값·OTP 코드·세션 토큰·API 키는 감사
  산출물에 포함하지 않는다. 검증에는 더미 값만 쓴다.
- 운영 D1·운영 Worker·라이브 엔드포인트·실제 메일 발송은
  감사에 사용하지 않는다.

## 산출물 위치

```
docs/security-audit/runs/run-<NNN>/
  run-metadata.json      # 실행 프로파일·스코프·소스 ref
  architecture.md        # 아키텍처·신뢰 경계 요약
  coverage-ledger.json   # 커버리지 유닛 (검증기 통과 필수)
  findings.json          # confirmed/needs_validation/rejected 기록
  REPORT.md              # 최종 보고서
  FINDINGS-DETAIL.md     # medium 이상 상세 재현
  NEEDS-VALIDATION.md    # 미해결 리드 목록
```

## 재감사

이전 run의 `coverage-ledger.json`/`findings.json`을 먼저 읽는다.
변경된 소스는 재검증하고, 미해결(`needs_validation`·`deferred`·
`blocked`·`out_of_scope`) 항목은 현재 작업으로 삼는다. 변경 없는
`confirmed`는 같은 fingerprint로 이어받되, 현재 검증 경로를 다시 거친다.

## 이력

- run-001 (2026-10-25): 시범 감사 — `quick`, 스코프 인증 모듈
  (`src/modules/auth/routes.ts`, `public/login.html`,
  `migrations/0043_auth_pins.sql`). 설치 검증용 첫 실행.
