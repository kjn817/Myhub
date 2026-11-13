# 실브라우저 e2e 스위트

`.scratch/`의 일회성 프로브를 반복 실행 가능한 테스트로 정리한 스위트다.
jsdom은 히트 테스트가 없어 "어떤 요소가 화면을 덮어 입력을 삼키는지"를 못 잡고,
레이어·뷰포트·로딩 타이밍 같은 실브라우저 성질도 검증하지 못한다 — 그 공백을
이 스위트가 메운다.

## 실행

```sh
npm run test:e2e              # 전수 실행 (순차, 병렬 아님)
npm run test:e2e -- desktop   # 이름에 desktop이 들어간 시나리오만
node tests/e2e/<이름>.e2e.cjs  # 단독 실행
```

- 각 시나리오는 성공 시 종료코드 0·실패 시 1, 콘솔에 `PASS`/`FAIL` 한 줄을 남긴다.
- 실패 시 스크린샷이 `.scratch/e2e-shots/<시나리오>-<타임스탬프>.png`에 저장된다.
- Chrome은 `~/.cache/puppeteer/chrome`에서 찾고, 없으면 `CHROME_PATH`를 쓴다.
- 스크립트는 반드시 myhub 트리 안에서 실행할 것 (`.cjs`, `playwright-core` 해석).

## 시나리오

| 시나리오 | 검증하는 성질 | 가드하는 수정 |
|---|---|---|
| `desktop-open-file` | 바탕화면 HWP·PDF 더블클릭 → 파인더+오피스 창 열림 | 38d30c6 (fileItemsByKey 모듈 스코프) |
| `office-loading-overlap` | 파일 열기 중 `#officeProgress` 요소 부재 + 부팅 로딩(`#officeBootLoading`)이 보였다가 사라짐 (100ms×60 샘플) | 2026-11-13 사용자 지시 (부팅 로딩이 첫 화면, 진행 막대 삭제) |
| `schedule-fill` | 3개 창 크기에서 달력 하단 간격 24px·주 행 균등, 짧은 창 스크롤 | 22e6de3 (높이 채움 레이아웃) |
| `studio-editor` | load 시 CodeMirror 요청 0건, 코드 탭 후 7개 자산 로딩·에디터 동작 | 9843c74 (CodeMirror 지연 로딩, import() 방식) |
| `hangul-loading` | 한글 로딩 화면이 엔진 로드 전에 보임 (제목·상태·스피너) | 38d30c6 (로딩 화면 조기화) |
| `browser-viewport` | 보이는 `.bw-stage` 크기가 live-session 뷰포트로 전송됨 | 04cd131 (뷰포트 소스 교정) |

## 하네스 (`harness.cjs`)

- `createServer({ onApi, fixtures, driveFiles })` — public/ 정적 서빙 + `/api` 스텁.
  기본 스텁: `/api/artifact`은 1.5s 지연 후 `{data: []}`, `/api/drive/list`는
  `ok: true` 필수(폴더 목록 / 파일 목록), `/api/drive/files/:id(/content)`는
  64바이트 제로, `/api/schedule/list`는 `{schedules: []}`, 그 외 `/api/*`는
  `{ok: true}`. `onApi`가 응답을 반환하면 기본 스텁을 대체한다.
- `launchBrowser()` / `throttleNetwork(ctx, page)` / `attachErrorCollector(page)` /
  `waitForDesktop(page)` / `assert`·`assertEq`·`assertNear`.
- `runScenario(name, fn, { timeoutMs })` — 타이밍·PASS/FAIL·실패 스크린샷·종료코드.
  시나리오 함수는 `t.server()`·`t.browser()`·`t.newPage()`로 자원을 만들고,
  래퍼가 종료 시 정리한다. 기본 타임아웃 120초.

## 시나리오 추가법

1. `tests/e2e/<이름>.e2e.cjs`를 만들고 `runScenario('<이름>', async (t) => {...})`로 감싼다.
2. 검증하는 성질이 깨지면 실패해야 한다 — 카나리아(동작을 일부러 깨뜨려 잡는지 확인)로
   증명할 것. 카나리아 복원은 역치환이나 백업 파일로만 할 것 (`git checkout --` 금지).
3. 공허한 통과를 피할 것: 전제(창이 열렸는지, 로딩이 보였는지)부터 단언하고,
   본 단언(겹침 0건 등)이 의미를 갖게 만든다.
4. 하드코딩 배열끼리 비교, mock 호출만 확인하는 단언, `expect(true)` 연극 금지.
   실브라우저의 실제 DOM·네트워크·창 상태를 확인할 것.
