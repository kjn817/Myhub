# Semgrep 게이트 방식 결정·구현 (2026-10-29, 트랙 D)

`docs/semgrep-recheck-20261029.md`가 미결정으로 남긴 "CI 게이트(`--error`/
베이스라인) 적용 여부"에 대한 결정과 구현 기록이다. 판정 근거(46건 전수
오탐)는 재검증 문서를 따르고, 본 문서는 게이트 메커니즘만 다룬다.

## 결정: 베이스라인 방식의 로컬/배포 전 게이트 (CI 게이트 아님)

- **CI는 존재하지 않는다** (아래 실측). 따라서 "CI 게이트"는 성립하지
  않으며, 대체재로 **체크인된 베이스라인 파일 + 로컬 게이트 스크립트**를
  둔다. 게이트는 사람이 실행할 때만 동작한다 — 자동 차단은 되지 않는다.
- 동작: 스캔 결과가 베이스라인과 같으면 통과(exit 0), **베이스라인에 없는
  신규 검출이 1건이라도 있으면 실패(exit 1)**, 베이스라인에만 있는 소실
  건은 경고만 출력하고 통과한다. 게이트 자체 오류(스캔 실패·스캔 errors·
  베이스라인 없음/파손)는 exit 2로 구분한다.
- 구현: `scripts/semgrep-gate.sh` (신규). 기존 `scripts/run-semgrep.sh`와
  `npm run lint:security` 경로는 무변경이다.

### 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| `semgrep --error` 전면 차단 | 현재 46건이 전부 오탐 판정 상태라 상시 실패하는 게이트가 된다. 아무도 안 돌리는 게이트와 같다 |
| Semgrep 네이티브 `--baseline-commit` | git 커밋 대비 변경 파일만 보는 방식이라, PR 없는 직접 배포 흐름(스테이징 없음·운영 직접 배포)에서는 기준 커밋이 모호하고, 재검증 문서의 건별 판정 목록과 대응하는 체크인 산출물이 남지 않는다 |
| `nosemgrep` 주석 / `.semgrepignore` 억제 | src/ 곳곳에 억제 표식을 심어야 하고(본 트랙 범위 밖), 판정 근거가 코드 주석에 흩어져 재검증 문서 같은 전수 대조가 불가능해진다. 규칙 자체를 끄는 것도 같은 이유로 기각 (재검증 문서 결론과 동일) |
| 줄번호 기반 베이스라인 (check_id+path+line) | 아래 "식별자 설계" 참조 — 줄 이동 churn으로 유지 불가 |

## CI 유무 실측 (2026-10-29, 브랜치 fix/unlock-block-remove-ciphertext)

- `.github/` 디렉터리 자체가 없음 (`.github/workflows` 포함).
- `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci`, `Jenkinsfile`,
  `bitbucket-pipelines.yml` 전부 없음. `git ls-files`에서 CI 관련 경로는
  `node_modules/` 내 타 프로젝트 소유 파일뿐 (본 저장소 CI 아님).
- 결론: GitHub Actions 등 어떤 CI도 이 저장소에서 돌지 않는다. 게이트를
  강제하려면 CI 도입 자체가 별도 결정 사항이다 (코디네이터/사용자 몫).

## 식별자 설계: check_id + path + snippet_hash + occurrence

베이스라인 항목 1건은 다음으로 식별한다.

- `check_id`: Semgrep 규칙 ID (예: `semgrep.myhub-sql-template-interpolation`)
- `path`: 저장소 상대 경로
- `snippet_hash`: 검출 구간(start~end line)의 **소스 라인을 공백 정규화**
  (줄별 앞뒤·연속 공백 축소)한 문자열의 sha256 앞 16자
- `occurrence`: (check_id, path, snippet_hash)가 같은 항목들 안에서의
  등장 순번 (line 순). 멀티셋 대조용
- `line`과 `snippet`(첫 줄 120자)은 사람이 읽는 참고 정보로만 저장하고
  **식별에는 쓰지 않는다**.

### 왜 줄번호를 식별자에서 뺐는가

- 실측된 churn: memo/routes.ts의 동일 검출이 2026-10-27에 157행 부근에서
  2026-10-29 재검증 때 215행으로 이동했다 (재검증 문서 기록). 줄번호 기반
  베이스라인이었다면 무관한 편집 한 번에 그 파일 전건이 "신규+소실"로
  폭발한다.
- Semgrep OSS(미로그인) JSON은 `extra.lines`/`extra.fingerprint`를
  `"requires login"`으로 가려서 그대로는 내용 기반 식별자를 만들 수 없다
  (2026-10-29 스캔 JSON 직접 확인). 그래서 게이트가 소스 파일을 직접
  읽어 해시를 계산한다. JSON 파싱에 jq 1.7도 사용 가능함을 확인했으나,
  소스 읽기가 필요해 python3(3.12.3) 하나로 통일했다.

### 식별자의 취약점 (수용한 것)

1. **검출 구간 자체의 토큰 편집**: 해시가 바뀌어 신규 1 + 소실 1 쌍으로
   나타난다. 검출 구간은 대부분 1~7줄(실측: memo/routes 검출은 4~7줄)로
   좁지만, 그 안의 무관한 편집도 재판정을 강제한다. 대안인 "첫 줄만 해시"는
   SQL 본문 변경 같은 진짜 변경을 놓칠 수 있어 기각했다 — 보안 게이트는
   fail-closed 쪽을 택한다.
2. **동일 코드 반복**: 같은 파일에 토씨까지 같은 검출 라인이 여러 개면
   (실측: `deploy_full.py`의 `urlopen(req)` 3건, backup/routes의
   `SELECT * FROM ${table}` 2건) occurrence 순번으로만 구분한다. 동일
   복사본을 추가하면 개수 증가로 신규 검출이 되지만(정상), 동일 복사본끼리의
   순서 교환은 탐지할 수 없다 — 코드가 동일하므로 위험 프로파일도 동일하다고
   본다.
3. **파일 rename·규칙 ID 변경**: path/check_id가 식별자에 포함되므로
   신규+소실 쌍이 된다. 의도된 동작이며, 갱신 절차에서 판정한다.
4. 소스 파일을 읽을 수 없는 검출(스캔 후 삭제 등)은 줄번호 기반 해시로
   강등하고 경고를 출력한다 (이 경우만 줄 이동에 취약).

## 사용법

```sh
bash scripts/semgrep-gate.sh                     # 게이트 검사
bash scripts/semgrep-gate.sh --update-baseline   # 베이스라인 재생성 (아래 절차 준수)
bash scripts/semgrep-gate.sh --baseline <path>   # 베이스라인 지정 (테스트용)
bash scripts/semgrep-gate.sh --scan-json <path>  # 저장된 스캔 JSON으로 대조 (테스트/디버그용)
```

- 종료 코드: 0=통과 / 1=신규 검출 / 2=게이트 자체 오류.
- 베이스라인: `.semgrep/baseline.json` — 2026-10-29 생성, 46건
  (semgrep 1.182.1, 기준 커밋은 파일 안 `generated_from_commit` 참조,
  규칙별 내역은 재검증 문서의 46건과 일치: sql-template 25 · urllib 15 ·
  hardcoded-secret 4 · locked-memo 1 · eval 1).
- semgrep 버전이 베이스라인 생성 시점과 다르면 경고만 출력한다 (규칙·ID
  변경 가능성을 알리는 용도).

## 베이스라인 갱신 절차 (판정 없는 갱신 금지)

1. 게이트 실패 시 신규 검출을 1건씩 코드로 확인한다.
2. 진짜 결함이면 코드를 고치고 다시 게이트를 돌린다.
3. 오탐이면 `docs/semgrep-recheck-20261029.md` 형식으로 **건별 판정 근거를
   문서에 먼저 남긴 뒤** `--update-baseline`을 실행한다.
4. 소실 경고가 쌓이면 같은 절차로 베이스라인을 정리한다 (경고는 통과를
   막지 않으므로 미뤄도 되지만, 방치하면 베이스라인이 낡는다).

판정 없이 `--update-baseline`부터 실행하면 게이트는 무력화된다. 이 절차가
게이트의 실효성을 결정한다.

## 실증 (2026-10-29, 전부 실제 실행)

| # | 검증 | 결과 |
|---|---|---|
| a | 현재 코드에서 게이트 실행 | **PASS, exit 0** — "신규 검출 0건 (현재 46건 = 베이스라인 46건 중 소실 0건)" |
| b | 카나리아: `eval(userInput)` 임시 파일(`semgrep-gate-canary.ts`, git stage 후 스캔 대상 보장) | **FAIL, exit 1** — 신규 검출 정확히 1건(`myhub-eval-or-new-function`, 해당 파일:3행) 지목. 검증 후 파일 삭제·unstage 완료 |
| c1 | 베이스라인 사본에서 1건 삭제 후 풀스캔 게이트 | **FAIL, exit 1** — 삭제한 건(apply_d1.py:42 urllib)이 신규 검출로 보고됨. 즉 베이스라인 항목을 지워서는 검출을 숨길 수 없고 오히려 실패한다 |
| c2 | 스캔 결과에서 1건을 뺀 JSON으로 대조(`--scan-json`) | **PASS, exit 0** + 소실 경고 1건만 출력 — 사라진 검출은 통과를 막지 않음 |
| d | 줄 이동 내성: apply_d1.py 맨 위에 주석 1줄 삽입 + 스캔 JSON의 해당 검출 행번호 +1로 대조(`--scan-json`) | **PASS, exit 0 (46/46 일치)** — 줄번호가 밀려도 해시 식별자가 유지됨. 파일은 git checkout으로 원복 확인 |

부수 관찰: 본 트랙 작업 중 병행 트랙이 `src/modules/memo/routes.ts`의
prepare 호출 구조를 실제로 편집했고, 그 구간 검출 5건이 신규+소실 쌍으로
잡히는 것도 확인했다 (취약점 1번의 실례 — fail-closed 동작). 베이스라인은
그 편집이 반영된 뒤의 코드로 생성했으므로 현재 트리와 일치한다.

## 한계

1. **CI 없음 = 강제력 없음.** 게이트는 실행한 사람에게만 효과가 있다.
   배포 절차(`deploy_full.py`)에 연결하거나 CI를 도입하는 것은 별도 결정
   사항이다 (본 트랙은 스크립트·문서까지만).
2. **레지스트리 규칙셋 드리프트**: `p/*` 규칙셋은 스캔 시점에 원격에서
   받아오므로, upstream 규칙 추가·변경이 신규 검출을 만들 수 있다. 이는
   fail-closed라 게이트 취지에는 맞지만, 갱신 판정 부담이 생긴다.
3. **스캔 범위 상속**: `scripts/run-semgrep.sh`의 제외 범위와 한계를
   그대로 따른다 — `public/*.html` 인라인 스크립트는 분석 대상이 아니며
   (재검증 문서 한계 참조), git이 추적하지 않는 파일의 스캔 포함 여부는
   본 트랙에서 별도 확인하지 않았다 (카나리아는 stage해서 확정적으로
   포함시켰다). 신규 파일을 stage/commit 전에 검사할 때는 이 점에 유의.
4. 스캔 1회에 약 1~2.5분이 걸린다 (이 환경 실측). 배포 전 수동 실행
   전제의 근거이자, 자주 돌리기 부담스러운 이유이기도 하다.

## 제안 (코디네이터 판단 몫, 본 트랙에서 적용하지 않음)

- `package.json`에 `"lint:security:gate": "bash scripts/semgrep-gate.sh"`
  스크립트 추가 (기존 `lint:security`는 무변경 유지).
- 배포 전 체크리스트(또는 `deploy_full.py` 사전 단계)에 게이트 실행을
  넣을지 여부.
- CI 도입 시에는 이 스크립트를 그대로 호출하면 되도록 설계했다
  (exit 코드 규약이 CI 관례와 동일).
