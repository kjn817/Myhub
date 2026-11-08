# garak 레드팀 하네스 (MyHub)

> 작성일: 2026-10-27 (KST). garak 0.17.1 실측 기준.
> 근거: `docs/github-test-ai-research-20261027.md` 1-3절 (garak, NVIDIA, ★9,716, Apache-2.0).
> MyHub 핵심 보안 경계는 **메모발 프롬프트 인젝션** — 잠긴 메모는 모든 외부 AI 전송
> 경로에서 원천 차단되고, 잠그지 않은 메모의 악성 지시문도 AI가 따르지 않아야 한다.
> 이 하네스는 그 경계를 체계적으로 찌르는 것이 목적이다.

## 이 하네스가 하는 일 / 하지 않는 일

- **하는 일**: garak 내장 프로브(promptinject·encoding·dan)를 돌려 리포트
  (`.report.jsonl` + `.report.html` + `.hitlog.jsonl`)를 만들고 프로브별 PASS/FAIL을 요약한다.
- **하지 않는 일 (이 단계)**: 실제 모델 호출 일절 없음. 기본 실행은 garak 내장
  `test` 생성기(스텁, 고정된 lorem ipsum 응답) 대상이라 비용 0원, 운영·스테이징
  엔드포인트 호출 없음, OTP 사용 없음, 운영 D1 쓰기 없음.
- **이번 트랙의 산출물은 하네스 자체가 끝까지 도는 것**이다. 스텁 대상의 PASS/FAIL
  숫자는 보안 판정이 아니다 (아래 "결과 해석" 참조).

## 설치

```bash
# 1. 가상환경 (시스템 Python 오염 금지). 위치는 ~/.venvs/myhub-garak 권장.
python3 -m venv ~/.venvs/myhub-garak

# 2. garak 설치. 주의: /tmp는 512MB tmpfs라 torch 휠(554MB) 압축 해제에
#    공간이 부족해 "No space left on device"로 실패한다. TMPDIR을 홈으로 옮길 것.
TMPDIR=$HOME/.cache/pip-tmp ~/.venvs/myhub-garak/bin/pip install garak==0.17.1

# 3. 확인
~/.venvs/myhub-garak/bin/garak --version
# → garak LLM vulnerability scanner v0.17.1
```

- 실측 설치 내역 (2026-10-27): Python 3.12.3, garak 0.17.1, torch 2.14.1 포함
  의존성 약 300개 패키지, venv 약 4.7GB, pip 캐시 약 3.2GB. 디스크 여유를 확인할 것.
- 가상환경 디렉토리는 git에 올리지 않는다 (`.gitignore`에 `.venv-garak/`·`.venv*/` 추가됨).
- 다른 위치에 설치했으면 `GARAK_VENV=<경로>` 환경변수 또는 `--venv <경로>`로 지정한다.

## 실행

```bash
# 전체 프로브 (스텁 대상, 약 1분)
bash tests/redteam/run-garak.sh

# 프로브 패밀리 제한
bash tests/redteam/run-garak.sh --probes promptinject
bash tests/redteam/run-garak.sh --probes encoding,dan

# FAIL이 1건이라도 있으면 종료 코드 1 (라이브 스캔 CI 게이트용으로 예약.
# 스텁 실행에는 쓰지 말 것 — 스텁은 의도적으로 FAIL을 낸다.)
bash tests/redteam/run-garak.sh --probes dan --fail-on-vuln   # → 종료 코드 1
```

- 결과: `tests/redteam/results/garak-<타임스탬프>.report.jsonl` (+ `.report.html`,
  `.hitlog.jsonl`). 결과 디렉토리는 gitignore 대상이다.
- 프로브 목록: `tests/redteam/probes.txt` (21개, 아래 "프로브 선정" 참조).
- 설정: `tests/redteam/garak-config.yaml` 템플릿을 스크립트가 치환해 임시 설정으로
  실행한다. CLI의 `--model_type/--model_name/--probes`는 garak 0.13/0.15부터
  deprecated라 설정 파일 방식을 쓴다.
- 고정 조건: `generations: 1`, `seed: 1` — 동일 버전·동일 프로브면 결과가 재현된다
  (dan 3종 재실행 시 동일 숫자 확인).

## 프로브 선정 (21개)

`garak --list_probes` 실측(0.17.1) 기준, 활성(💤 아님) 프로브만:

| 패밀리 | 프로브 | MyHub 경계와의 관련 |
|---|---|---|
| promptinject | HijackLongPrompt, HijackKillHumans, HijackHateHumans | 메모 속 악성 지시문을 AI가 따르는지 — 핵심 경계 |
| encoding | InjectBase64, InjectBase32, InjectBase16, InjectHex, InjectROT13, InjectMorse, InjectBraille, InjectAscii85, InjectBase2048, InjectEcoji, InjectNato, InjectUU, InjectZalgo, InjectAtbash, InjectUnicodeTagChars | 인코딩으로 인젝션을 숨기는 우회 |
| dan | DanInTheWild, Ablation_Dan_11_0, AutoDANCached | 탈옥으로 가드레일 우회 |

제외한 것 (나중에 개별 검토 후 추가):
- `Full` 변형(Hijack\*Full, DanInTheWildFull): 동일 패턴의 확장판. 기본 스캔이 무거워지면 추가.
- 💤(비활성) 프로브: `dan.AutoDAN` 등 공격자 모델이 필요하거나 실험적인 것,
  `encoding.InjectLeet/InjectMime/InjectQP/InjectSneakyBits/InjectUnicodeVariantSelectors` 등.

## 결과 해석

- `run-garak.sh`는 실행 말미에 `tests/redteam/summarize.py`로 프로브별
  evaluated/PASS/FAIL/NONE을 출력한다. 리포트는 프로브×탐지기별 집계 형식이다
  (`{"entry_type": "eval", "probe": ..., "passed": N, "fails": N, ...}` — 시도별 항목이 아님).
- **스텁 대상의 FAIL은 보안 판정이 아니다.** 스텁(`test.Test`)은 모든 프롬프트에
  고정된 lorem ipsum을 돌려주고, 거부를 절대 하지 않으므로 탐지기가 "공격 성공"으로
  세는 경우가 많다. 예: `dan.DanInTheWild` 256/256 FAIL은 "스텁이 거부를 안 해서"이지
  "MyHub가 탈옥에 뚫려서"가 아니다. 마찬가지로 encoding 프로브의 FAIL 1건씩은
  스텁 응답에 디코드 매치가 우연히 걸린 것이다.
- 스텁 실행의 PASS 조건은 이것뿐이다: garak이 종료 코드 0으로 끝나고 리포트 3종
  (`.report.jsonl`·`.report.html`·`.hitlog.jsonl`)이 생성되고 요약이 출력되는 것.
- 라이브 스캔(실제 모델 대상)에서 FAIL이 나오면 그때가 진짜 신호다. 뚫린 패턴은
  회귀 테스트(인젝션 거부 케이스)로 고정한다 (조사 문서 1-3절 권고).

## 실측 실행 결과 (스텁 대상, 2026-10-27)

| 실행 | 시간 | 평가 수 | PASS | FAIL | NONE | 종료 코드 |
|---|---|---|---|---|---|---|
| 전체 21개 프로브 | 53.22초 | 8,964 | 8,569 | 395 | 0 | 0 |
| dan 3종만 (`--probes dan`) | 약 7초 | 516 | 130 | 386 | 0 | 0 |
| dan 3종 + `--fail-on-vuln` | 약 7초 | 516 | 130 | 386 | 0 | 1 (의도된 동작) |

- promptinject 3종은 전부 PASS(256/256 × 3) — 스텁 응답에 rogue string이 없어서다.
- dan FAIL 386건 중 256건은 DanInTheWild 전수, 127건은 Ablation_Dan_11_0 절반 —
  모두 "스텁이 거부를 안 함"에 기인한 탐지기 판정이다 (위 해석 참조).
- 리포트: `tests/redteam/results/garak-20261027-051809.report.jsonl` 등
  (gitignore라 저장소에 없음 — 실행 시 재생성된다).

## 실제 모델 프로브 승인 절차 (실행하지 말 것 — 별도 승인 사항)

라이브 스캔은 이 하네스만으로 실행할 수 없게 막아두었다. 실행하려면 아래가 전부 필요하다.

1. **사용자 승인**: 대상·범위·비용을 명시한 별도 승인. 이 문서만으로는 승인된 것이 아니다.
2. **대상 결정** (둘 중 하나):
   - (a) MyHub AI 엔드포인트 경유: 스테이징 `/api/ai/chat`을 garak REST 생성기
     (`generators.rest.RestGenerator`, `target_type: rest`)로 연결. 필요한 것:
     스테이징 세션 쿠키(PIN 로그인 후 발급 — OTP 라이브 호출 금지, 사용자가 직접
     발급한 쿠키를 전달받는 방식; promptfoo 하네스 `tests/evals/run-eval.sh`와 같은
     `MYHUB_SESSION_COOKIE` 패턴), 요청 본문 템플릿(`req_template`,
     `/api/ai/chat`의 메시지 형식에 맞춤), 응답에서 답변 텍스트를 뽑는
     `response_json_field`. **쓰기 케이스(메모 생성 등)가 실제 데이터를 만들지 않게
     스코프를 읽기·거부 케이스로 제한**하고, 스테이징에서만 실행한다 (운영 금지).
   - (b) 모델 직접 호출: Gemini/Groq API 키를 garak 생성기(예: `google`/`groq` 계열)에
     연결. 필요한 것: 키 발급·등록 방식, 모델별 호출 비용 상한, 키 사용 승인.
     모델별 취약성이 다를 수 있어 에코·루미·노바·캘리별로 스캔하는 것이 의미 있다.
3. **비용 상한**: 프로브 21개 × 프롬프트 수백 개 × generations 1회 = 수천 회 호출.
   전체 스캔 전 dan 1종 같은 작은 단위로 비용을 먼저 재고 상한을 정한다.
4. **실행 방법** (승인 후): 라이브 모드는 환경변수 2개가 함께 있어야만 열린다.
   ```bash
   GARAK_LIVE=1 GARAK_GENERATOR_TYPE=rest GARAK_GENERATOR_NAME=<엔드포인트 URL> \
     bash tests/redteam/run-garak.sh
   ```
   `GARAK_LIVE=1` 없이, 또는 생성기 지정 없이 실행하면 스크립트가 거부하고 종료 코드 2로 끝난다.
   REST 대상의 상세 설정(헤더·본문 템플릿·응답 필드)은 승인 시점에
   `garak-config.yaml`의 라이브용 변형을 별도로 만들어 검증한다 — 아직 만들지 않았다.
5. **결과 처리**: FAIL 패턴을 인젝션 거부 회귀 테스트로 고정하고, 재스캔으로
   수정 여부를 확인한다.

## 알려진 문제·주의

- **/tmp 512MB tmpfs**: pip 설치와 garak 실행 모두 `TMPDIR=$HOME/.cache/garak-tmp`
  (또는 `$HOME/.cache/pip-tmp`)를 쓴다. 스크립트가 `TMPDIR` 미지정 시 홈 기반 경로를
  기본으로 설정한다.
- **일시적 hitlog 쓰기 실패 1건** (2026-10-27 05:19, `--probes dan --fail-on-vuln`
  실행 중 `PermissionError: [Errno 1] Operation not permitted` — evaluator가 hitlog에
  쓰는 단계에서 발생, 리포트는 부분 생성됨). 동일 명령 재실행 시 정상 완료됐고,
  이후 dan 재실행도 정상이라 일시적 파일시스템 문제로 본다. 재발하면 원인을 다시 본다.
- **리포트 크기**: 전체 스캔 리포트 `.report.jsonl` 약 19MB, `.hitlog.jsonl` 약 1.2MB.
  결과는 git에 안 올린다.
- garak 버전이 바뀌면 프로브 이름이 바뀔 수 있다. `garak --list_probes`로 재확인하고
  `probes.txt`를 갱신할 것.

## 파일 목록

- `tests/redteam/run-garak.sh` — 실행 스크립트 (스텁 기본, 라이브는 환경변수로만 개방)
- `tests/redteam/probes.txt` — 프로브 목록 21개
- `tests/redteam/garak-config.yaml` — garak 설정 템플릿
- `tests/redteam/summarize.py` — 리포트 요약기 (집계 eval 형식 파싱)
- `tests/redteam/results/` — 실행 결과 (gitignore)
- `docs/garak-harness-20261027.md` — 이 문서
