# 데스크톱 성능 기준선 — 측정 기록 (2026-10-31)

트랙 5 (GPT 6.7 재평가 P1: "모듈형 데스크톱은 동작은 검증됐으나 실제 성능·자원 소비는 미측정").
이 문서는 **측정만** 다룬다. 코드는 한 줄도 바꾸지 않았다.

| 항목 | 값 |
|---|---|
| 측정일 | 2026-10-31 오후 (KST) |
| 코드 기준 | 브랜치 `fix/unlock-block-remove-ciphertext`, HEAD `b20098c` |
| 측정 대상 | 운영 `https://myhub.myhub-app.workers.dev` (라이브 버전 `d27cd930` @100%, 과제 지정값) |
| 측정 방식 | ① curl HTTP 실측 (인증 세션, 항목당 5회 반복·중앙값, 독립 2개 배치로 교차 확인) ② 로컬 파일 바이트 실측 + gzip 추정 ③ 코드 전수 감사 ④ 실제 `state.js`를 Node에서 실행한 직렬화 크기 실측 |
| 인증 | `.scratch/ai_smoke.py`의 OTP 로그인 패턴 응용 (OTP 요청 → D1 코드 조회 → verify → 세션 쿠키를 `/tmp`에만 보관, 측정 후 삭제). 이후 측정은 전부 GET 읽기 전용 — 생성·수정·삭제 없음 |

> **정정 기록 (2026-10-31, 같은 날)**: 초판 커밋의 §2.1·§2.2·§2.5·§2.6·§8 일부 수치가 측정 배치 원본과 불일치해(예: API 응답 크기를 와이어 바이트가 아닌 값으로 기재, ASSETS 압축 부재로 오기), 독립 2개 배치에서 바이트 단위까지 일치한 와이어 실측 기준으로 전면 교체했다. 정정된 값은 두 배치 모두에서 동일하게 관찰된 것들이다.

## 0. 브라우저 가용성 — 렌더링 측정은 NOT TESTED

- 이 VM에서 `chromium`, `chromium-browser`, `google-chrome` 모두 없음 (`which` 무결과).
- Puppeteer는 모듈·Chromium 바이너리 모두 부재로 실행 불가. Playwright 패키지는 있으나 브라우저 바이너리가 없어 동일하다. 다운로드 시도는 과거 기록대로 차단 경로라 장기 설치를 시도하지 않았다.
- 따라서 **실제 렌더링 지표(첫 화면 사용 가능 시간의 실측, FPS, JS 힙 메모리, CPU 프로파일)는 전부 NOT TESTED**다. 아래 HTTP·코드 기반 수치는 그 대체 측정이며, 브라우저 실측으로 포장하지 않는다.

## 1. GPT 측정표 대조

| GPT 측정 항목 | 상태 | 결과 요약 |
|---|---|---|
| 첫 화면 사용 가능까지 시간 | **대체 측정** | 브라우저 실측 불가. HTTP 하한 추정: 셸 HTML 총시간 중앙값 506ms + 모듈별 API 직렬 체인 합산 (채팅 ≈1.77초, §2.6). 다운로드·파싱·렌더 시간은 미포함이라 실제 체감은 이보다 길다 |
| 모듈 4개 동시 실행 시 메모리·CPU | **NOT TESTED** (수치) / 코드 감사 완료 | 힙·CPU 실측 불가. 정적 근거: 창은 모듈당 싱글턴이라 동시 실행은 최대 4개 iframe으로 구조적으로 상한이 있다 (§6) |
| 드래그·리사이즈 프레임 | **NOT TESTED** (FPS) / 코드 감사 완료 | 이동은 `transform`, 리사이즈는 `left/top/width/height` 직접 변경, rAF 스로틀 없음 (§5) |
| 최소화된 창의 불필요한 렌더링·API 호출 | **측정됨 (코드+산술)** | 폴링 API 0건 — 최소화된 창 포함 전 모듈에 주기 네트워크 호출이 없다. 단 iframe은 언로드하지 않아 메모리는 유지되고, 새로고침 시 최소화된 창도 전부 다시 로드된다 (§3) |
| 창 10개 반복 개폐 후 메모리 누수 | **NOT TESTED** (힙) / 코드 감사 완료 | "창 10개"는 구조적으로 불가능 (모듈 4개 싱글턴). 닫기 정리 경로 감사에서 전역 리스너 누적은 없었고, 후보 3건을 §6에 명시 |
| 느린 네트워크 지연 | **NOT TESTED** | 스로틀링 실측 불가. 코드 사실: 창별 로딩 표시가 셸에 없고, 복원 시 전 창 동시 로드, lazy loading 없음 (§7) |
| 새로고침 복구 시 상태 보존 | **기존 기록 인용** | 2026-10-30 브라우저 QA 7/7 PASS (`docs/qa-browser-20261030-1608.md`) — 이번 트랙에서 재실행한 것이 아니다. 상태 데이터 자체의 크기는 이번에 실측: 4창 최대 414바이트 (§4) |

## 2. 전송·로드 지표 (HTTP 실측)

### 2.1 인증 동작부터

- 무인증 curl 배치에서는 HTML 5종과 정적 에셋이 **전부 `302 → /login.html`** 로 응답했다 (리다이렉트를 따라가지 않은 측정, 본문 0바이트). 즉 페이지 지표는 인증 없이는 잴 수 없고, 아래 수치는 전부 인증 세션 기준이다.

### 2.2 페이지·에셋 크기 (로컬 파일 실측)

| 파일 | 원본 바이트 | gzip 추정(레벨 6, 로컬 계산) | 비고 |
|---|---:|---:|---|
| `desktop.html` (셸) | 1,460 | 689 | 운영 서빙본은 1,515바이트 (§2.5 각주) |
| `shell.css` | 3,552 | 1,363 | 셸·전 모듈 공용 |
| `css/desktop.css` | 5,514 | 1,781 | |
| `nav.js` | 6,118 | 2,558 | 셸·전 모듈 공용 |
| `js/desktop/state.js` | 10,502 | 3,279 | |
| `js/desktop/windows.js` | 13,352 | 4,035 | |
| `js/desktop/main.js` | 1,109 | 579 | |
| `memo.html` | 8,237 | 2,646 | |
| `css/memo.css` | 38,348 | 8,311 | |
| `js/memo-bundle.js` | 138,101 | 38,663 | 단일 파일로는 최대 |
| `schedule.html` | 29,056 | 8,504 | 인라인 스크립트 13,426자 포함 |
| `js/google-connect.js` | 8,953 | 3,028 | 일정만 |
| `todo.html` | 25,697 | 7,787 | 인라인 스크립트 13,754자 포함 |
| `chat.html` | 6,282 | 2,236 | |
| `css/chat.css` | 18,859 | 4,720 | |
| `js/chat.js` | 39,523 | 11,750 | |
| `js/voice.js` | 10,812 | 3,666 | 채팅만 |
| `assistant-widget.js` / `.css` | 13,384 / 3,066 | 4,282 / 1,133 | 메모·일정·할 일에 로드 |
| `icon-192.png` | 7,314 | — | 전 페이지 공용 |

- **셸 자체 합계: 48,921바이트** (위 셸 8개 파일, 외부 CDN 제외).
- 압축·캐시 헤더 (실측): `?v=`를 붙인 JS 응답은 `Content-Encoding: gzip` + `Cache-Control: public, max-age=31536000, immutable` + `CF-Cache-Status: HIT`로 서빙됐다 — 버전 정적 에셋은 압축·장기 캐시가 적용되고 있다. HTML 응답은 `Content-Encoding: gzip` + `Cache-Control: no-store, no-cache, must-revalidate`.

### 2.3 외부 CDN (전 페이지 공통의 큰 덩어리)

| URL | 원본 바이트 (1회 실측) | 비고 |
|---|---:|---|
| `unpkg.com/lucide@latest/dist/umd/lucide.min.js` | **476,077** (gzip 전송 111,922) | 셸 + 모듈 4개 페이지 **전부** 로드. `@latest`라 302 리다이렉트 후 버전 파일(관찰 시 1.66.0)로 이동; 리다이렉트 응답 `max-age=60`, 버전 파일은 immutable |
| `cdn.jsdelivr.net/npm/marked/marked.min.js` | 39,903 | 메모만. 첫 관측 1회는 TTFB 6.2초로 튀었다 (단일 표본, 중앙값 아님 — CDN/망 변동으로 기록만) |
| `cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js` | 29,828 | 메모·채팅 |
| `cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js` | 35,159 | 채팅만 (메모와 다른 CDN·다른 버전) |
| `cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js` | 121,727 | 채팅만 |
| `cdnjs …/highlight.js styles/github.min.css` | 1,309 | 채팅만 |

### 2.4 아바타 이미지 — 채팅의 최대 전송원

- 아바타 WebP 실측: rumi 347,912 / nova 295,414 / echo 267,436 / cali 236,858바이트.
- `chat.html:43-58`이 4개를 `<img>`로 즉시 로드한다 (`loading="lazy"` 없음). **채팅 창 하나가 아바타만으로 1,147,620바이트**를 받는다.
- 메모·일정·할 일도 비서 위젯 아바타 1개씩을 로드한다 (메모 echo 267,436 / 일정·할 일 cali 236,858). 브라우저 캐시가 공유하더라도 최초 1회는 각 크기만큼 전송된다.
- 모듈별 자체 오리진 합계 (공용 파일 중복 포함, 아바타 포함, 외부 CDN 제외): 셸 48,921 / 메모 485,556 / 일정 308,301 / 할 일 295,989 / 채팅 1,240,080바이트. 중복을 제거한 고유 파일 합계는 1,536,859바이트 (24개 파일).

### 2.5 운영 엔드포인트 시간 (인증, 5회, 중앙값 — 최종 배치)

| 경로 | 응답 와이어 바이트 | TTFB 중앙값 | 총시간 중앙값 |
|---|---:|---:|---:|
| `/desktop.html` | 1,515 | 466ms | 506ms |
| `/memo.html` | 8,391 | 344ms | 381ms |
| `/schedule.html` | 29,155 | 407ms | 477ms |
| `/todo.html` | 25,785 | 448ms | 527ms |
| `/chat.html` | 6,458 | 440ms | 480ms |

- 서빙 HTML이 로컬 파일보다 55~176바이트 큰 것은 배포 시 버전 쿼리(`?v=`) 재작성으로 참조가 길어지기 때문이다 (§2.2 표는 로컬 원본).
- 와이어 크기는 독립 2개 배치에서 전 항목 일치했다. 시간은 배치 간 변동이 크다 (예: 같은 날 다른 배치에서 `desktop.html` 총시간 중앙값 390ms, `/api/ai/conversations` 751ms). 이 VM의 경유 망 특성상 절대값보다 크기 순서(수백 ms 대)로 읽어야 한다.

### 2.6 초기 API 호출 목록 (코드 확정 + 실측)

셸 자체는 API를 호출하지 않는다 — `desktop.html`과 `js/desktop/*.js`에 `fetch`가 없다. 시계는 로컬 DOM 갱신뿐이다 (§3.1).

| 모듈 | 초기 호출 (코드 근거) | 구조 | 응답 와이어 바이트 | 총시간 중앙값 |
|---|---|---|---:|---:|
| 메모 | `GET /api/memo/tags` (`memo-bundle.js:1032`) | `init.js:6-7`에서 목록과 병렬 시작 | 2 (빈 배열 `[]`) | 392ms |
| 메모 | `GET /api/memo` (`memo-bundle.js:1129`) | 위와 병렬 | 6,149 (메모 28건) | 522ms |
| 메모 | `GET /api/memo/<id>/files` × N (`memo-bundle.js:1150`) | 목록 후 백그라운드 병렬. 실측 시점 `file_count>0`인 메모 1건 → **1회** | 개별 미측정 | — |
| 메모 | `GET /api/ai/conversations/active?personaId=keeper` (`assistant-widget.js:33`) | 위젯 초기화 시 | 32 | 596ms |
| 일정 | `GET /api/schedule/list?from=2026-10-01&to=2026-10-31&status=active&limit=500` (`schedule.html:320`, init `:621-627`) | 단독 | 3,779 | 535ms |
| 일정 | `GET /api/push/vapid-key` (`schedule.html:559`) | `initPush()`가 렌더 후 실행, 서비스워커 등록 포함 | 113 | 485ms |
| 일정 | `GET /api/ai/conversations/active?personaId=scheduler` | 위젯 초기화 시 | 32 | 516ms |
| 할 일 | `GET /api/todo/list?status=pending` (`todo.html:289`) | `loadAll()` 안에서 **순차** | 1,820 | 356ms |
| 할 일 | `GET /api/todo/list?status=done` (`todo.html:290`) | 위 완료 후 순차 | 195 | 413ms |
| 할 일 | `GET /api/ai/conversations/active?personaId=scheduler` | 위젯 초기화 시 | 32 | (일정과 동일 URL) |
| 채팅 | `GET /api/ai/personas` (`chat.js:43`) | **직렬 체인** 시작 (`chat.js:681`) | 425 | 465ms |
| 채팅 | `GET /api/ai/conversations` (`chat.js:463`) | personas 완료 후 | **134,020 (대화 316건, 페이지네이션 없음)** | 847ms |
| 채팅 | `GET /api/ai/room-history?limit=30&conversationId=null` (`chat.js:523`) | conversations 완료 후. 초기 `currentConvId`가 `null`(`chat.js:6`)이라 문자열 `"null"`로 호출됨 | 41 | 454ms |

- 합계: 4개 모듈 초기 API 응답 ≈ **146,640바이트**, 그중 채팅 대화 목록이 **134,020바이트 (91%)** 를 차지한다. 대화가 쌓일수록 이 초기 비용은 선형으로 는다 — 이번 측정이 찾은 가장 큰 성능 사실이다.
- 직렬 체인의 HTTP 하한 (중앙값 단순 합산, 다운로드·렌더 제외): 채팅 465+847+454 ≈ **1,766ms**, 할 일 356+413 ≈ **769ms**. 메모·일정은 병렬/단독이라 해당하지 않는다.
- 참고 실측: 실제 대화 ID를 쓴 `room-history`는 대화에 따라 481바이트·386ms, 2,513바이트·340ms로 관찰됐다. 즉 채팅 초기 체인의 마지막 호출은 현재 구현상 내용이 빈 `null` 조회로 끝나고, 실제 기록은 대화 선택 시 다시 불러온다.

## 3. 유휴·최소화 시 동작

### 3.1 타이머·폴링 전수

`public/` 전체에서 `setInterval`은 2곳뿐이다.

| 위치 | 주기 | 하는 일 | 네트워크 |
|---|---|---|---|
| `public/nav.js:19` | 30초 | 상단바 시계 텍스트 갱신 (`tickClock`) | 없음 (DOM만) |
| `public/js/login.js:178` | 1초 | 로그인 화면 타이머 — 데스크톱 모듈 아님 | 없음 |

- 모듈 4개 페이지·셸·비서 위젯 어디에도 폴링 `fetch`, `visibilitychange`/`document.hidden` 분기가 없다 (grep 무결과).
- 나머지 `setTimeout`/`requestAnimationFrame`은 전부 일회성 (검색 디바운스 300ms, 포커스 지연, 토스트 소멸 등)이다.
- **산술 추정: 유휴 상태에서 모듈 전체의 주기적 네트워크 요청 = 분당 0건.** 최소화된 창도 같다. 유휴 비용은 네트워크가 아니라 §3.2의 메모리 유지다.

### 3.2 최소화된 창의 취급 (keep-alive)

- `public/js/desktop/windows.js:125` — iframe은 창 생성 시 1회만 만들고 `src`를 그때만 설정한다 (주석에도 keep-alive 명시).
- `windows.js:238` — 최소화는 `display: none` 토글뿐이다. iframe을 언로드·제거하지 않는다. CSS도 `.dt-window.dt-minimized { display: none; }` (`css/desktop.css`).
- 결과: 최소화된 모듈은 문서·JS 힙·타이머(시계 30초)를 그대로 유지한 채 화면에서만 사라진다. 주기 API가 없으므로 네트워크 낭비는 0이지만, **메모리 절약 효과도 0**이다 — 복원 속도와의 맞교환이며 설계 문서(`docs/desktop-workspace-design-20261030.md` 8절)의 의도된 선택이다.
- 단, 새로고침 복원 시에는 최소화된 창도 예외 없이 iframe이 생성·로드된다 (`sync()`가 `minimized` 여부와 무관하게 `createWindowEl`을 호출). 즉 "최소화 상태로 복원된 창"도 초기 API 비용(§2.6)을 전액 다시 낸다.

## 4. 상태 복원 비용

- 저장 키: `myhub.desktop.v1` (`state.js:17`). 구조는 `{version, windows:[{id, module, x, y, w, h, z, minimized}], activeId, zCounter}` (`state.js`의 `cloneWindow`/`serialize:234`).
- 실제 `state.js`를 테스트와 같은 방식(fake window 로더)으로 Node에서 실행해 잰 직렬화 크기:
  - 빈 상태 55바이트 / 창 1개 142바이트 / **창 4개 전부 + 포커스 100회로 zCounter를 204까지 올린 상태 414바이트**.
  - 싱글턴 구조상 창은 최대 4개라 이 크기가 사실상 상한이다. localStorage 용량·파싱 비용 모두 무시할 수준.
- 복원 경로: `main.js`의 `init()` → `stateApi.load(localStorage, viewport)` (`state.js:306-318`) → `parse`가 검증·clamp 후 복원 (`state.js:246`). 깨진 항목 제거·중복 module 제거·version 불일치 시 빈 상태 등 방어 로직이 있고, 저장(`save`)은 상태 전이 때마다 동기 호출되지만 대상이 수백 바이트라 비용이 없다.
- 동작 자체의 브라우저 검증은 기존 기록을 인용한다: 2026-10-30 QA에서 창 3개 구성·위치·크기·겹침 순서 복원과 닫힌 창 유지가 7/7 PASS (`docs/qa-browser-20261030-1608.md`, 당시 버전 `fe7b1a7a`). **이번 트랙은 재실행하지 않았다.**

## 5. 드래그·리사이즈 (코드 감사 — FPS는 NOT TESTED)

- `windows.js`의 `onPointerMove` (218행 등록): 이동 중에는 `transform: translate(...)`만 바꾸고 (합성 경로), 리사이즈 중에는 `left/top/width/height`를 직접 바꾼다 (레이아웃 유발). 상태 확정·localStorage 저장은 `pointerup` 시 1회만 (`onPointerUp`).
- `css/desktop.css` — `#dt-root.dt-dragging .dt-frame { pointer-events: none; }`: 드래그 중 iframe이 포인터를 가로채는 것을 막는 장치가 있다.
- 없는 것: `requestAnimationFrame` 스로틀 — `pointermove` 이벤트마다 스타일을 쓴다. 고주사율 환경에서 프레임당 1회를 넘는 쓰기가 생길 수 있으나, 실제 드롭 프레임 여부는 브라우저 없이는 판정 불가 (NOT TESTED).
- 리사이즈는 iframe 자체의 크기 변경이라 내부 페이지 리플로우를 동반한다 — 셸 코드로 줄일 수 있는 비용이 아니다.

## 6. 반복 개폐·누수 감사 (코드 — 힙 실측은 NOT TESTED)

### 닫을 때 실제로 정리되는 것

- `windows.js:244-245` (`sync()`): 상태에 없는 창은 `rec.el.remove()` + `entries.delete(id)`. iframe 요소가 DOM에서 제거되면 그 문서·타이머·리스너는 브라우저가 함께 파괴하는 것이 표준 동작이다 — 단 이는 코드 근거의 추론이며 힙 스냅샷으로 확인한 것이 아니다.
- 창별 리스너(최소화·닫기·제목줄·리사이즈 핸들 8개·본문 포커스, `windows.js:135-175`)는 전부 창 요소 내부에 붙어 요소와 함께 제거되고, 셸이 그 참조를 따로 보관하지 않는다.
- 전역 리스너는 매니저당 1회만 등록된다 (`document pointermove/pointerup` 218-219행, `window resize` 320행). 창 개폐로 누적되지 않고, `destroy()`(327행)가 이를 해제한다.
- 모듈이 싱글턴이라 (같은 모듈 재실행은 기존 창 복원) 동시 창은 최대 4개 — "창 10개를 열어 둔" 상태 자체가 만들어지지 않는다.

### 결함 후보 (이 트랙에서는 고치지 않음)

1. **`pointercancel` 미처리**: `windows.js`에 `pointercancel` 리스너와 `setPointerCapture`가 없다. OS 제스처·알림 등으로 포인터가 취소되면 `drag` 세션과 `dt-dragging` 클래스, 임시 `transform`이 다음 `pointerup`까지 남을 수 있다.
2. **명시적 iframe 종료 절차 없음**: 닫기는 `el.remove()`에만 의존하고 `src` 비우기 같은 명시 해제는 없다. 표준상 충분하지만, 모듈 페이지 내부의 `document` 단위 리스너(예: 할 일의 `touchmove`)·진행 중 `fetch`의 정리는 전적으로 브라우저의 문서 파괴에 맡긴다 — 실브라우저 검증 전까지는 "정리됨"이 아니라 "정리될 것으로 코드상 기대됨"이다.
3. **`sync()`마다 전체 아이콘 재스캔 + 작업 표시줄 재구성**: 포커스 변경 같은 가벼운 전이에도 `sync()`(249행)가 `lucide.createIcons()` 전체 스캔을 돌리고, 작업 표시줄 창 버튼 영역을 `innerHTML=''`로 비우고 다시 만든다 (277행). 창이 최대 4개라 절대량은 작지만, 상호작용 빈도에 비례하는 상수 비용이다.
4. 채팅 내부 문제(셸이 아닌 모듈): 대화 316건을 매번 전량 받아 316개 DOM 항목으로 그린다 (§2.6). 채팅 창을 열 때마다 반복되는 비용이라 개폐 반복 시 체감이 누적된다.

## 7. 느린 네트워크 (NOT TESTED — 코드 사실만)

- 스로틀 환경 실측은 하지 못했다. 코드에서 확인되는 사실:
  - 셸에 창별 로딩 표시(스피너·스켈레톤)가 없다. `createWindowEl`은 빈 흰 iframe(`.dt-frame` 배경 #fff)을 바로 붙이며, 로딩 표시는 각 모듈 페이지 내부 것에 의존한다.
  - lazy loading이 없다: 복원·생성 즉시 전 창의 iframe `src`가 설정되고, 최소화된 창도 포함된다 (§3.2). 느린 망에서는 보이지 않는 창과 보이는 창이 대역폭을 나눠 갖는다.
  - 서비스워커(`public/sw.js`)는 `?v=` 버전 정적 에셋만 CacheFirst이고 `/api/*`는 NetworkOnly라, 재방문 시에도 API 비용(§2.6)은 그대로다.

## 8. 발견한 성능 사실 요약 + 후속 후보

### 사실

1. 초기 비용의 중심은 셸이 아니다 (48,921바이트). **채팅 대화 목록 134,020바이트 (페이지네이션 없음, 316건)** 와 **아바타 이미지 4개 1,147,620바이트** 가 전체를 지배한다.
2. 폴링이 전혀 없어 유휴·최소화 상태의 네트워크 비용은 분당 0건이다. 최소화의 대가는 트래픽이 아니라 유지되는 iframe 메모리다 (수치는 NOT TESTED).
3. Lucide 476,077바이트(원본)를 셸+모듈 5개 문서가 각자 로드한다. `@latest` 비고정 + 리다이렉트 1회 포함.
4. 버전 정적 에셋은 gzip + immutable 장기 캐시로 서빙됨을 헤더로 확인했다. 반대로 HTML·API는 매번 네트워크를 타는 구조다 (HTML `no-store`, API는 SW NetworkOnly).
5. 상태 저장 데이터는 최대 414바이트로, 복원 비용의 병목이 아니다.
6. 채팅 초기 체인 마지막에 `conversationId=null` 조회(41바이트, 총시간 중앙값 454ms)가 끼어 있다 — 크기는 작지만 직렬 체인이라 시간은 그대로 더해진다.

### 후속 측정·개선 후보 (우선순위 순, 전부 미착수)

1. **실브라우저 측정**: 사용자 PC 등 Chromium 가능 환경에서 첫 화면 사용 가능 시간, 4창 동시 힙, 드래그 FPS, 개폐 10회 후 힙 — 이 문서의 NOT TESTED 전부.
2. 대화 목록 페이지네이션/요약 필드 축소 (134KB → 초기 체인 단축).
3. 아바타 리사이즈·축소 (표시 크기에 맞는 변형본, 채팅 1.15MB 해소).
4. Lucide 버전 고정 + 자체 호스팅 또는 사용 아이콘만 서브셋.
5. 복원 시 최소화된 창은 lazy-load (첫 복원 클릭 시 로드) 검토.
6. `pointercancel` 처리 추가 (§6 후보 1).
7. 리사이즈 `pointermove`에 rAF 스로틀.

## 9. 방법·한계

- HTTP: curl + 브라우저 UA, 항목당 5회, 중앙값, 독립 2개 배치 교차 확인 (와이어 크기는 전 항목 일치, 시간은 배치 간 변동 큼). 측정망은 이 VM의 네트워크로 사용자 실환경(모바일 등)과 다르다.
- 크기: API·HTML은 운영 응답의 와이어 바이트(`size_download`) 기준, 파일 표는 로컬 원본 기준이며 둘의 관계는 §2.5 각주에 적었다. gzip 열은 로컬 `gzip -6` 계산값이다.
- 코드 감사 범위: `public/desktop.html`, `public/js/desktop/*.js`, `public/css/desktop.css`, 모듈 4개 페이지와 그 스크립트 (`memo-bundle.js`, `chat.js`, `google-connect.js`, `assistant-widget.js`, `nav.js`, `sw.js`)의 타이머·호출 전수 grep + 해당 구간 정독.
- 하지 않은 것: 코드 수정, 배포, 브라우저 실행, 데이터 생성·변경. OTP 로그인은 측정 세션 확보 목적만으로 기존 스모크 패턴을 따랐고, 세션 값은 문서·저장소 어디에도 남기지 않았다.

---

## 10. 트랙 C — 대화 목록 다이어트 (2026-10-31, 구현·테스트 완료, 배포는 환경 차단으로 보류)

§8 후속 후보 2번("대화 목록 페이지네이션/요약 필드 축소")의 실행 기록이다.

### 10.1 병목의 실체 (배포 전 라이브 실측, 2026-10-31 16:55~17:00 KST)

- 배포 전 `GET /api/ai/conversations` 와이어 바이트 **134,020B·316건**을 3회 반복 실측으로 재확인했다 (기준선 §2.6과 바이트 단위 일치). 쿼리 파라미터는 구 계약에서 무시됐다.
- 필드별 바이트 분해 (응답 재구성 기준 근사): **last_msg 100,562B (75.0%)** · title 16,777B (12.5%) · updated_at 12,324B (9.2%) · id 2,432B (1.8%) · 나머지 JSON 구조.
- last_msg 실태 (D1 집계): 마지막 메시지 전문이 실린다. 문자 수 합계 56,977자, 건당 평균 180자(메시지 있는 건 기준 199자), **최대 5,095자**, 40자를 넘는 건이 156건. 유일한 소비처인 chat.js 목록 미리보기는 `slice(0, 40)`만 쓴다 — 즉 last_msg 바이트의 대부분이 표시되지 않는 전송이었다.
- 소비처 전수: `GET /api/ai/conversations`의 소비처는 **public/js/chat.js의 loadConversations 1곳뿐**이다 (데스크톱은 chat.html을 iframe으로 띄우므로 같은 경로). 쓰는 필드는 id·title·last_msg뿐이고 대화 검색 UI는 존재하지 않는다 (목록은 최신순 표시·클릭 열기·삭제만). assistant-widget은 별도 엔드포인트 `/conversations/active`를 쓰며 무영향.

### 10.2 바꾼 계약 (커밋 0d34d10)

| 항목 | 전 | 후 |
|---|---|---|
| 건수 | 전량 (316건) | 기본 최근 **50건**, `limit` 상한 100 |
| last_msg | 전문 (최대 5,095자) | 서버 SQL `substr(...,1,40)` 미리보기 절단 |
| 페이지네이션 | 없음 | `?limit=&offset=`, 응답에 `hasMore`·`limit`·`offset`·`nextOffset` |
| 정렬 | updated_at DESC | updated_at DESC, **id DESC** (페이지 경계 안정용 타이브레이커) |
| 클라이언트 | 전량 렌더 | 첫 페이지 + "이전 대화 더 보기" 버튼으로 누적 (중복 id 방지, 실패 시 console.warn 후 재시도 가능) |

- 필드 구성은 유지했다: `{id, title, updated_at, last_msg}` (updated_at은 UI 미사용이나 호환 위해 유지).
- 응답 메타 필드 추가는 기존 소비처에 무해하다 (chat.js 외 소비처 없음, 기존 단위 테스트 283건 무수정 통과).

### 10.3 테스트 (실행 증거)

- 신규: 실 SQLite 계약 테스트 7건 (tests/integration/conversation-list.test.ts — 필드 구성, 40자 절단, 3페이지 이어보기로 120건 전량 도달·중복 없음, 경계·상한 클램프, 메시지 없는 대화 last_msg=null, 첫 페이지 15KB 미만) + 파라미터 정규화 5건 + jsdom 소비처 테스트 3건 (초기 50건+버튼, 이어보기 2회로 120건 도달·버튼 소멸, 클릭 시 대화 열기).
- 카나리아: SQL 절단을 제거하면 절단·바이트 테스트 2건이 실패하는 것을 확인하고 복원했다.
- gate-23(빈 catch 금지)이 신규 클라이언트 코드의 빈 catch를 잡아 console.warn으로 수정했다.
- **전수 Jest: 287 suites / 5,733 tests 전부 PASS. tsc PASS.**
- 런타임(vitest/miniflare)은 이 VM의 쓰기 차단으로 workerd SQLite가 `SQLITE_IOERR_WRITE`로 기동 실패해 **NOT TESTED** (코드 오류가 아닌 환경 오류, 단일 파일·3회 재시도 모두 동일).

### 10.4 배포 상태 — 환경 차단으로 보류 (정직 기록)

- `deploy_full.py production`을 12회 시도했으나 전부 **생성 단계**(NODE_GEN이 `.deploy-assets`에 정적 파일 39개를 쓰는 구간)에서 `EPERM: operation not permitted, write`로 중단됐다. 업로드·승격 단계에 도달한 시도는 없으며 **운영은 여전히 d27cd930 @100%**다 (배포 전 실측이 구 계약 그대로인 것으로도 확인).
- 실패 지점은 시도마다 전진했고(6개 파일→13개 파일에서 중단), 단건 대용량 쓰기는 성공하는 등, 이 VM에서 반복 관측된 "지속 벌크 쓰기 시 차단이 내려오는" 패턴과 일치한다. 코드·스크립트 수정으로 우회하지 않았다 (정식 배포 경로는 단일 경로 유지).
- **재개 레시피**: 쓰기 차단이 풀린 시점에 ① `python3 deploy_full.py production` ② 성공하면 `.scratch/trackc-perf-probe.py AFTER`로 후 실측 (기대값: 첫 페이지 ≈7KB 내외, §10.5에 기입) ③ 라이브 QA (OTP 후 목록·이어보기·대화 열기·삭제 확인).

### 10.5 배포 완료 + AFTER 실측 (2026-10-31, 트랙 1)

- **배포 완료**: `python3 deploy_full.py production` 1회 성공 (EPERM 재발 없음). 이전 활성 `d27cd930-61fb-4ddb-9f06-cf4711d81992` → 새 버전 **`c7d37b29-018b-4300-97c6-48d7384f9a96` @100%**, `DEPLOY VERIFY PASS`, 시크릿 가드 PASS (이름 30개 유지), Cron `*/5 * * * *` 확인, 에셋 45개·버전 `5d30b944`. 이 배포에는 트랙 C(0d34d10)·트랙 D(f4ce101, ai.ts 분해)와 스테이징 문서 커밋(ec2f42d)이 함께 실렸다.
- **배포 전 가드**: `tsc --noEmit` PASS, 관련 Jest 6 suites / 356 tests PASS (conversation-list 계약·파라미터·chat 목록 UI·ai-routes·ai-memo-fc-tools·ai-tools-registry). 전수 Jest는 이번 트랙에서 재실행하지 않았다 (직전 기록 §10.3의 5,733 PASS가 같은 코드 기준).
- **AFTER 실측** (`.scratch/trackc-perf-probe.py AFTER`, OTP 로그인 후 각 경로 3회, 중앙값 — 3회 전부 동일 바이트):

| 경로 | 전 (§10.1) | 후 (실측) | 건수 | hasMore / nextOffset | max last_msg |
|---|---:|---:|---:|---|---:|
| `GET /api/ai/conversations` (무파라미터) | 134,020B / 316건 | **9,357B** | 50 | true / 50 | 40자 |
| `?limit=50&offset=0` | (구 계약 무시) | 9,357B | 50 | true / 50 | 40자 |
| `?limit=50&offset=50` | — | 9,943B | 50 | true / 100 | 40자 |
| `?limit=50&offset=300` | — | 2,893B | 16 | false / null | 40자 |

- **대비**: 첫 페이지 134,020B → **9,357B (-124,663B, -93.0%, 약 1/14)**. §10.4의 기대값 "≈7KB 내외"는 예상치였고 실제는 9,357B다 — 제목 등 나머지 필드가 차지하는 몫 때문이며, last_msg 절단(40자)은 전 건에서 확인됐다. 페이지네이션 끝(offset=300에서 16건, hasMore=false)까지 도달해 전량 316건 도달 가능성도 라이브로 확인됐다.
- **배포 후 QA (스크립트, 같은 세션)**: 주요 페이지 5종(메모·일정·할일·채팅·데스크톱) 전부 200, `/api/health` 200, AI 스모크 1회 PASS (concierge, HTTP 200, 모델 gemini-3.5-flash-lite), 보호 메모 게이트 유지 PASS — 잠긴 메모 단건 열람·덮어쓰기 모두 세션만으로 `403 STEP_UP_REQUIRED` (본문은 읽지 않고 상태·에러 코드로만 판정).
- **NOT TESTED**: 브라우저 종단 흐름(목록 "더 보기" 클릭·대화 열기·삭제의 실제 화면 동작)은 이 VM에서 브라우저 실행이 불가해 미검증 — jsdom 소비처 테스트(§10.3)가 코드 경로를 고정하고, 라이브 API 계약은 위 실측으로 확인됐다.
