# GPT 분석 요청 — MyHub 배포 검증 반복 실패 원인

**작성일:** 2026-10-14
**작성자:** Muse (사용자 요청)

---

## 증상

`deploy_full.py production` 실행 시 다음 패턴이 반복됨:

1. `UPLOAD SUCCESS` — Worker 업로드는 성공
2. 배포 검증 단계에서 실패:
   - `verify /login.html content '?v=737eeba9': ERR IncompleteRead(0 bytes read) FAIL`
   - 또는 `ERR Remote end closed connection without response FAIL`
3. `DEPLOY VERIFY FAIL — 배포 검증 실패`
4. `승격 차단: 검증 실패로 100% 트래픽 승격을 수행하지 않습니다.`

3회 이상 재시도해도 동일한 실패 반복.

## 수동 확인 결과

- `curl https://myhub.myhub-app.workers.dev/login.html` → HTTP 200 정상
- `curl`로 본문에서 `?v=737eeba9` 마커 확인됨
- 즉, 사이트 자체는 정상 동작하지만 Python `urllib`에서의 검증만 실패

## 검증 코드 (deploy_full.py의 verify_deployment 함수)

```python
# 콘텐츠 검증: /login.html(공개·no-cache) 본문에 이번 배포의 에셋 버전(?v=)이 있어야 함.
if asset_ver:
    marker = f'?v={asset_ver}'
    try:
        req = urllib.request.Request(base_url + '/login.html?vfy=1',
                                     headers={'User-Agent': 'MyHubDeploy/1.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            login_code = r.status
            login_body = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        login_code = e.code
        login_body = ''
    except Exception as e:
        login_code = f'ERR {e}'
        login_body = ''
    ok = (login_code == 200 and marker in login_body)
    print(f"  verify /login.html content {marker!r}: {login_code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
    if not ok:
        failed = True
```

## 전체 배포 스크립트

첨부: `deploy_full.py` (위에서 전문 인용됨)

## 질문

1. 왜 `urllib.request.urlopen`에서 `IncompleteRead(0 bytes read)` 또는 `Remote end closed connection`이 반복 발생하는가?
   - `curl`은 정상인데 Python `urllib`만 실패하는 이유는?
   - `timeout=15`가 짧은가? `/login.html`의 크기는?
   - `User-Agent` 헤더 문제인가?
   - Cloudflare의 봇 차단인가?

2. 검증 로직 자체의 문제는 없는가?
   - `?vfy=1` 쿼리 파라미터가 캐시에 영향을 주는가?
   - `no-cache`인 `/login.html`을 매번 전체 본문으로 읽는 방식이 적절한가?
   - 더 안정적인 검증 방법은?

3. 이전에는 성공했는데 최근에 실패하기 시작한 이유는?
   - 83차까지는 검증이 통과했음
   - 84차부터 반복 실패 (코드 변경은 경미함)
   - Cloudflare 측 변경인가, 아니면 우연한 네트워크 문제인가?

## 제약

- 운영 배포는 검증 PASS 후 100% 트래픽 승격이 원칙
- 검증을 우회하는 것은 안전상 바람직하지 않음
- 하지만 현재 상태로는 84차 코드를 운영에 반영할 수 없음
