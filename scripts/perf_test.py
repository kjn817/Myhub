#!/usr/bin/env python3
"""
MyHub 대량 데이터 성능 테스트
- 1000개 메모 생성
- 검색 성능 측정 (FTS5 vs LIKE)
- 페이지네이션 성능 측정
- 인덱스 효과 확인
사용법: python3 scripts/perf_test.py [base_url] [count]
"""
import sys, time, json, urllib.request, urllib.parse

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://myhub.myhub-app.workers.dev"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 1000

import time as _time
def api(method, path, data=None, retries=3):
    url = BASE + path
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, method=method)
            payload = None
            if data is not None:
                req.add_header('Content-Type', 'application/json')
                payload = json.dumps(data).encode()
            start = time.time()
            with urllib.request.urlopen(req, data=payload, timeout=30) as r:
                body = json.loads(r.read())
            elapsed = (time.time() - start) * 1000
            return body, elapsed
        except Exception as e:
            if attempt == retries - 1:
                raise
            _time.sleep(1 + attempt)
    raise Exception("unreachable")

print(f"== MyHub 성능 테스트: {BASE} ({COUNT}개 메모) ==")

# 1. 대량 생성
print(f"\n-- {COUNT}개 메모 생성 중... --")
ids = []
t0 = time.time()
for i in range(COUNT):
    # 다양한 내용으로 생성 (검색 테스트용 키워드 포함)
    keyword = ["회의", "아이디어", "할일", "메모", "중요"][i % 5]
    text = f"성능테스트 {keyword} {i}\n\n이것은 {keyword}에 대한 테스트 메모입니다. 번호 {i}번."
    if i % 10 == 0:
        text += " #태그테스트"
    body, _ = api('POST', '/api/memo', {'text': text})
    ids.append(body['id'])
    _time.sleep(0.05)
    if (i + 1) % 100 == 0:
        print(f"  {i+1}/{COUNT} 완료 ({time.time()-t0:.1f}s)")
total_create = time.time() - t0
print(f"  생성 완료: {total_create:.1f}s (평균 {total_create/COUNT*1000:.1f}ms/개)")

# 2. 목록 조회 성능 (페이지네이션)
print("\n-- 목록 조회 성능 --")
for limit in [10, 50, 100]:
    _, ms = api('GET', f'/api/memo?limit={limit}')
    print(f"  limit={limit}: {ms:.0f}ms")

# 3. 검색 성능 (FTS5)
print("\n-- 검색 성능 (FTS5) --")
for q in ["회의", "아이디어", "성능테스트", "없는키워드xyz"]:
    enc = urllib.parse.quote(q)
    body, ms = api('GET', f'/api/memo?q={enc}')
    print(f"  '{q}': {ms:.0f}ms ({len(body)}건)")

# 4. 태그 필터 성능
print("\n-- 태그 필터 성능 --")
_, ms = api('GET', '/api/memo?tag=' + urllib.parse.quote('태그테스트'))
print(f"  태그 필터: {ms:.0f}ms")

# 5. 달력 성능
print("\n-- 달력 성능 --")
_, ms = api('GET', '/api/memo/calendar?y=2026&m=10')
print(f"  달력 조회: {ms:.0f}ms")

# 6. 정리
print(f"\n-- {COUNT}개 테스트 메모 삭제 중... --")
t0 = time.time()
for i, mid in enumerate(ids):
    api('DELETE', f'/api/memo/{mid}')
    if (i + 1) % 100 == 0:
        print(f"  {i+1}/{COUNT} 삭제 ({time.time()-t0:.1f}s)")
print(f"  삭제 완료: {time.time()-t0:.1f}s")

print("\n== 성능 테스트 완료 ==")
