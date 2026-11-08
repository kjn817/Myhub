# P2: Python 실행 환경 보안 검토

## 현재 구현
- Pyodide (Python WASM) via CDN: https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js
- 실행 위치: 브라우저 내 sandboxed iframe
- Sandbox 속성: `sandbox="allow-scripts"` (allow-same-origin 없음)

## GPT 우려사항 vs 현재 구현

### GPT 우려
> Python 코드는 서버에서 임의 실행할 수 있도록 연결해서는 안 됩니다.

### 현재 상태: ✅ 서버 실행 없음
- Python 코드는 D1에 텍스트로만 저장됨
- 서버에서 절대 실행하지 않음
- 실행은 100% 클라이언트 측 (Pyodide WASM)

### 격리 수준
| 항목 | 상태 |
|------|------|
| 서버 실행 | ❌ 없음 (텍스트 저장만) |
| 부모 페이지 접근 | ❌ 차단 (sandbox, no allow-same-origin) |
| 인증 쿠키 접근 | ❌ 차단 (opaque origin) |
| MyHub API 접근 | ❌ 차단 (인증 쿠키 없음) |
| 파일시스템 접근 | ❌ 없음 (브라우저 샌드박스) |
| 네트워크 접근 | ⚠️ 가능 (Pyodide 내 fetch) |

### 네트워크 접근에 대한 고찰
Pyodide 내 Python 코드는 `urllib`이나 JS interop을 통해 네트워크 요청 가능.
그러나:
1. sandboxed iframe이므로 MyHub 인증 컨텍스트 없음
2. 일반 웹사이트와 동일한 수준의 네트워크 접근 (사용자가 직접 방문하는 것과 동등)
3. 악성 코드가 외부로 데이터를 유출할 수는 있으나, MyHub 내부 데이터에는 접근 불가

### 결론
현재 Pyodide 구현은 GPT가 우려한 "서버에서 임의 실행" 시나리오에 해당하지 않음.
클라이언트 측 샌드박스 실행으로 보안 요구사항 충족.

### 향후 강화 (선택)
- CSP로 Pyodide iframe의 외부 도메인 제한
- Python 코드 정적 분석 (위험 패턴 경고)
