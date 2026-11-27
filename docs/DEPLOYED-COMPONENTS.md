# 배포된 컴포넌트 기록 (D4, 2026-11-27)

oci-tools는 git 저장소가 아니라 사이드카 변경을 커밋할 수 없다.
그래서 배포된 sidecar.js의 sha256을 이 파일에 기록한다 — 다음 변경 때
이 값과 대조해 무엇을 바꿨는지 추적한다. Worker 버전도 함께 적는다.

## 현재 배포 상태 (2026-11-27)

| 컴포넌트 | 배포 식별자 | 비고 |
|---|---|---|
| sidecar.js | sha256 `124c4e8efa018a784ba6a6bff1354313d5b36a39bbc4503dc9b0b85fa223e359` | D1(401 HTML nav-key 주입 금지) + D2(주석 damage-gated 교정) 포함. 이전 `b01f5c13…` |
| Worker (myhub) | 버전 `1f2e4bfc` (AV 228a06c3, 시크릿 35개) | D3(/android-view Basic 주입 제거) 포함. 이전 `0bbeb446` |

## 경로

- 사이드카 소스: `~/workspace/oci-tools/bootstrap/sidecar/sidecar.js`
  (로컬 정본 — oci-tools는 git 저장소가 아님)
- 사이드카 서버: `/opt/myhub-browser/sidecar/sidecar.js`
  (백업: 같은 디렉토리의 `sidecar.js.bak-<태그>-<시각>`)
- 서버의 스테이징: `/tmp/myhub-bootstrap/sidecar/sidecar.js.new`
  (전달은 패치 + sha256 대조로 한다 — 전체 파일 전송은 청크가 많아 느리다)

## 갱신 규칙

- sidecar.js를 바꿔 배포할 때마다 이 파일의 해시를 새 값으로 갱신하고,
  같은 커밋에 포함한다 (커밋 메시지에 이전 해시→새 해시를 적는다).
- Worker를 배포할 때마다 버전·AV·시크릿 개수를 갱신한다.
