# RECONSTRUCTION-PUBLIC-MAP — public/ 파일별 처분표

기준: 2026-11-07 운영 상태(버전 a2702ca4)를 목표로, 2026-11-01 베이스라인 +
회수 실물 + 기록(일일 로그 2026-11-01~07, AGENTS.md, RECONSTRUCTION-DELTA.md)
기반으로 재구성했다. 분류 4종: [회수 실물 이식] / [베이스라인 무변경] /
[기록 기반 재구성] / [재구성 불가].

집계: 대상 파일 140개 (이 표 파일 자체 제외) — 회수 실물 이식 7 ·
기록 기반 재구성/신규 49 · 베이스라인 무변경 84
(무변경 중 12개는 회수 실물과 바이트 동일 확인 후 유지).
재구성 불가 항목은 파일이 아니라 아래 별도 목록으로 남긴다.
`scripts/static-assets.json`은 48개 → 94개로 확장했다 (기존 48 + 확정 8 +
재구성으로 실재하게 된 참조 파일 38; 파일이 없는 항목은 넣지 않았다).

## 1. 회수 실물 이식 (7)

| 파일 | 근거 |
|---|---|
| login.html | .recovery/live-assets 회수본 이식. 배포 변환분 `?v=cacc0c9c`만 제거 |
| css/login.css | 회수본 그대로 (4,470B) |
| js/login.js | 회수본 그대로 (7,556B) |
| vendor/lucide/lucide.min.js | lucide 1.67.0 공식 배포본 — login.html의 SRI sha384와 정확히 일치 |
| vendor/jszip.min.js | JSZip 3.10.1 — 회수 실측 크기(97,630B) 일치 |
| vendor/xlsx.full.min.js | SheetJS 0.18.5 — 881,727B |
| vendor/mammoth.browser.min.js | mammoth 1.6.0 — 642,759B |

## 2. 기록 기반 재구성/신규 (49)

### 셸·데스크톱 (17)
| 파일 | 근거 |
|---|---|
| nav.js | 재작성. 설정 버튼 기어 전용(#settingsBtn), 애플 메뉴식 myhub- 드롭다운, addSettingsItems 레지스트리, Google 연동은 설정 메뉴 안 (D-33). ~/memory/2026-11-05~07 |
| shell.css | 상단바 34px+안전영역 하한 4px(실측 바 38px), 시계 translateY(-2px), html.myhub-embedded에서 .g-nav 숨김 + --topnav-h:0 (D-15) |
| js/login-visual.js | PIN 점 동기화 + 오류 시 흔들림 (원본 43줄 계약, .card.shake는 login.css 소유) |
| js/file-icons.js | D-32 최종: 접힌 모서리 페이지 모양 안쪽만 흰색·밖은 투명, kind 14종, Material Icon Theme 5.40.0(MIT) 핀. ㅎ 글리프는 폰트 텍스트 근사 (정본 path는 재구성 불가 목록 참조) |
| desktop.html | 로딩 표면(근검정+JN+가는 흰 바 정적 마크업), 상단바(JN·앱 액션·시계·비서 슬롯), 표면 레이어, 독, 서브챗 호스트 |
| css/desktop.css | 창 바 40px·신호등 14px/간격 9px/오프셋 17px·창 반경 16px (2026-11-06 정본), 독 48px/간격 10px/존 96px, 히트 테스트 계약(#dt-root pointer-events:none), 레이어 위젯 z1<창 z2<독 z70, 셸 스크롤바 숨김 (D-25) |
| js/desktop/state.js | v2 Spaces(창별 space·마이그레이션·수리), MODULES 12종(finder 920×620 선두, 오피스는 /office.html?app=), 동적 등록 registerModule(app-<id>) |
| js/desktop/tiles.js | 동적 생성 직후 refreshIcons 필수 (빈 타일 사고 수정), 사용자 앱 아이콘 PNG 실패 시 글리프 폴백 |
| js/desktop/windows.js | 통합 창 크롬, 줌/전체화면 modes{mode,prev}, rootTopOffset 실측, 줌 해제 드래그 4px 이연, 미션 컨트롤 선택 모드(Enter 확정·ESC 취소·350ms 가드·렌더 기하 winrect), 칩 바 1.4초, 앱 액션/비서 아바타 프록시, Finder 핸드셰이크, 오피스 open-file 재전송(bridge-ready), doc-title dirty 주황 점 |
| js/desktop/dock.js | 마이그레이션 v2~v5, 독 안 드래그 순서 변경(구분선 동반), 최근 앱 3개, 휴지통 배지 |
| js/desktop/desktop-icons.js | D-14 격자 스냅(왼쪽 위·행 우선·nearestFreeCell), 저장 v8, Set 선택+그룹 드래그, 휴지통 공유 키 'myhub.desktop.trash.v1', dt-remove-zone 없음 |
| js/desktop/widgets.js | 오늘·저장소·시스템 카드, 순서 'myhub.desktop.widgets.v1', snapWidgetPos(간격·임계 12px, 축별 독립), 리사이즈 핸들+sizes v3(최소 220×96) |
| js/desktop/menu.js | 공용 우클릭 메뉴 (myhub- 접두사) |
| js/desktop/wallpaper.js | 날짜 버전 URL Image() 프로브 선행, 캡션 병렬, loadPref는 어떤 값도 {mode:'today'}로 정규화, 프록시 경유 (CSP) |
| js/desktop/subchat.js | D-18 셸 싱글턴 패널, hello 재선언, uiAction은 활성 창 iframe으로 재타기팅, 승인 토큰 필드 제거 |
| js/desktop/version-guard.js | 버전 불일치 시 세션당 1회 자동 새로고침 |
| js/desktop/main.js | 조립: state→매니저·독·아이콘(밴드 표면=#dt-surface)·위젯·배경·서브챗·동적 모듈, 독 휴지통 메뉴/비우기(Drive 폴더 전부+via_folder 아닌 파일 순차 삭제), 하단 6px peek |

### Finder (11)
| 파일 | 근거 |
|---|---|
| finder.html | 사이드바(즐겨찾기·위치+#sideUsage), 목록, 뷰어 DOM 계약(#finderViewer/#fvName/#fvSave/#fvBody/#fvChrome) |
| css/finder.css | 열 헤더 정렬·줄무늬·파란 선택·하단 경로+상태 한 줄, 행 아이콘 22px 틴트 없음 |
| css/picker.css | 공용 선택기 계약 (오피스·Finder 공유, myhub-picker-*) |
| js/finder.js | v3 (D-15): 즐겨찾기 'myhub.finder.favorites.v1'(토글·이름 추종·자동 정리), 전역 검색+소속 폴더 (D-22), 휴지통 통합 보기(icontrash 행), 핸드셰이크 ready/open-view/open-file+ack, win-tools 게시, 오피스 파일은 해당 앱으로 |
| js/finder-viewer.js | registerFormat 레지스트리, createSave(base_version·409 안내), ctx(fetchRaw/fetchText/save) |
| js/finder-format-text.js | 텍스트 편집·저장 + 이미지 미리보기 |
| js/finder-format-hwp.js | kordoc readText 우선, 실패 시 서버 추출 폴백, ownsChrome |
| js/finder-format-sheet.js | SheetJS 격자 (앞 300행), ownsChrome |
| js/finder-format-slide.js | JSZip+slide XML 텍스트 추출, ownsChrome |
| js/finder-format-doc.js | mammoth HTML 변환 |
| js/finder-format-pdf.js | PDF 앱 iframe 교체, ready 20초 무응답 시 네이티브 임베드 폴백+고지, canSave(앱 위임) |

### 오피스 (14)
| 파일 | 근거 |
|---|---|
| office.html | 메뉴 줄(파일·편집 + 접기 셰브론 우측 끝 단독), 시작 화면 hidden 기본값, 엔진 표면+실패 고지 |
| css/office.css | 호스트 크롬, myhub-menu |
| js/office.js | 앱 라우팅·autoNew 직행(PDF는 templates/blank.pdf), 파일 메뉴(열기·저장은 메뉴 안에서만), 최근 8개, 접기(뷰어/에디터 단일 표면), 인쇄 D-23(한글은 클릭 시점 창 확보), doc-title+dirty 게시, open-file 핸드셰이크 |
| js/office-fetch.js | 로드·저장(base_version·409), 신규 생성 |
| js/office-memory.js | 최근 파일 최대 8개(로컬), 마지막 앱 |
| js/office-picker.js | 보관함 선택기 (picker.css 계약) |
| js/office-assistant.js | 브리지 컨텍스트 선언 + uiAction을 엔진으로 배분 |
| js/assistant-bridge.js | D-18 앱 측: 임베드 표식, bridge-ready/hello 재선언, 내비 키 채널, uiAction 배분(토큰 필터), setTitle |
| js/fonts.js | Drive '폰트' 폴더 페이스 자동 등록(사용자 폰트 우선), gridcraft:fonts 푸시 |
| sheet.html | GridCraft 호스트, 손실 가드 배너/veil, 폴백 링크 |
| js/sheet-gridcraft.js | myhub-sheet:* ↔ gridcraft:* 번역(set_cell→cell.set, insert_table→range.setValues+home.bold, sort_range→data.sort 절대 열, format_range→home.*), inspectXlsxLosses(매크로=보기 전용/차트/이미지) |
| sheet-fortune.html | FortuneSheet 폴백 호스트 |
| rhwp-studio/myhub-file-menu.js | '보관함에서 열기/저장' 배선만 (셰브론 삽입 로직 없음 — 최종 상태), handleHwp.ownsChrome=true |
| templates/blank.pdf | 최소 유효 빈 PDF 생성 (PDF 빈 문서 직행용) |

### 브라우저 (4)
| 파일 | 근거 |
|---|---|
| browser.html | D-20: 탭 스트립은 창 바 안, 주소 캡슐, '브라우저 시작' 단일 버튼, 시작 페이지(안내 카드+즐겨찾기 6+최근 방문), 하단 알약 |
| css/browser.css | 주소 캡슐 36px·창 폭 50%(220~640px), 시작 콘텐츠 768px·타일 64px |
| js/browser.js | 탭 모델, 최근 방문 'myhub.browser.recents.v1', resolveLiveFactory 없으면 fail-fast |
| js/browser-live.js | {createLive}: iframe에 /api/browse/view/ 직접 연결, POST /api/browse/navigate로 영구 탭 이동 (2026-11-14 Oracle 전환, live-session 폐기) |

### 오프라인 (3)
| 파일 | 근거 |
|---|---|
| offline.html | 베이스라인의 인라인 스타일·스크립트를 분리 형태로 재구성 |
| css/offline.css | 위 분리분 |
| js/offline.js | 다시 시도 + online 복귀 시 자동 새로고침 |

## 3. 베이스라인 무변경 (84)

델타 기록이 없거나, 회수 실물과 바이트 동일이 확인돼 그대로 둔 파일.

- 페이지: agent.html, backup.html, briefing.html, chat.html, index.html,
  key-rotation.html, memo.html, memory.html, schedule.html, search.html,
  todo.html, trace.html
- 스타일: css/chat.css, css/memo.css
- 스크립트: js/chat.js, js/memo/ 16개, js/memo-bundle.js, js/google-connect.js,
  js/key-rotation.js, js/step-up.js, js/trace.js, js/voice.js,
  assistant-widget.js, assistant-widget.css, sw.js
  - assistant-widget: D-18로 서브챗 경로는 bridge로 대체됐지만, 베이스라인
    페이지들이 여전히 참조하고 11-07 자산 집합 포함 여부가 기록으로 확정되지
    않아 베이스라인을 유지했다. (운영 대조 QA에서 확인 필요)
- 이미지·기타: icon-192.png, icon-512.png, apple-touch-icon.png, jn-logo.png,
  wallpaper.webp, splash/ 4개 — 회수 실물과 바이트 동일 확인 후 유지
- avatars/: cali·echo·nova·rumi.webp는 11-07 회수 실물과 동일 확인 후 유지.
  builder·concierge·keeper.webp와 media-generation-*.json은 자산 집합 밖
  베이스라인 잔존물로 무변경.
- manifest.json: 회수본(라이브 442B)이 프로브 매니페스트와 파일명 충돌로
  덮여 소실 — 베이스라인(357B) 유지. 회수본과의 상세 차이는 불명.

## 4. 재구성 불가 (파일로 존재하지 않음)

| 항목 | 사유 |
|---|---|
| 사용자 제공 앱 아이콘 PNG (/icons/finder-app.png 824×824, excel-app-v3, hangul-app-v2, powerpoint-app-v3, browser-app-v4, studio-app-v4 등) | 운영 ASSETS에만 존재하고 회수 경로가 닫힘 (인증 302·API 역방향 읽기 없음 실측). tiles는 로드 실패 시 글리프 폴백으로 동작 |
| vendor/gridcraft (WASM 17,259,748B 등), vendor/deckcraft, vendor/pdfcraft, rhwp-studio 빌드 본체, kordoc 번들(3.2MB) | 엔진 소스가 소실된 .scratch에 있었음. 호스트 페이지(sheet.html·office.html·finder-format-hwp)는 엔진 부재 시 폴백/고지로 동작하게 재구성 |
| vendor/fortune (fortune.js 4,989,028B + fortune.css 50,584B) | 번들 소실. sheet-fortune.html은 로드 실패 시 고지 표시 |
| file-icons ㅎ 글리프 정본 path | Noto Sans KR Bold 외곽선 추출 path 데이터 소실 — 폰트 텍스트로 근사 |
| manifest.json 회수본 (442B) | 위 3항 참조 |

## 5. 추측으로 채운 부분 (운영 대조 QA에서 확정 필요)

- Drive API 세부 엔드포인트: 휴지통 이동/복원(POST …/trash, …/restore),
  검색(/api/drive/search), 사용량 응답 형태 — 계약(동작)만 기록에 있고
  경로는 관용 형태로 채웠다. finder.js 상단 api 객체에 모아 둠.
- /api/system 응답 형태 (위젯 summarizeSystem은 관용 필드명으로 방어 구현).
- ~~`/api/browse/live-session` 응답 필드명(id/viewUrl/limitSec/expiresAt)~~ —
  2026-11-14 폐기됨 (Oracle 프록시로 전환, live-session 라우트 없음).
- 오피스 엔진 메시지 프로토콜(myhub:engine-ready, office-export 등)은
  엔진이 재구성 불가라 호스트 측 계약만 정의했다.
- 접기 셰브론 위치: 정본 기록(제목줄 첫 자리 vs 메뉴 줄 우측 끝)이 충돌해
  2026-11-03 06:52 최신 정본(그 줄의 가장 우측 끝에 혼자)을 따라
  office.html 메뉴 줄 우측 끝에 배치했다.
