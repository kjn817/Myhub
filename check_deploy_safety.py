#!/usr/bin/env python3
"""MyHub 배포 후 안전 검증: 재발 방지 체크"""
import sys
import subprocess
import json

def check_wrangler_toml():
    """wrangler.toml이 인라인 번들을 가리키는지 확인"""
    with open('wrangler.toml') as f:
        content = f.read()
    if 'main = "src/index-inline.ts"' in content:
        print("✓ wrangler.toml: 인라인 번들 사용 중")
        return True
    else:
        print("✗ wrangler.toml: src/index.ts를 직접 가리킴 (리다이렉트 루프 위험!)")
        print("  수정: main = \"src/index-inline.ts\"로 변경 필요")
        return False

def check_auth_middleware():
    """인증 미들웨어가 쿼리스트링을 처리하는지 확인"""
    with open('src/index.ts') as f:
        content = f.read()
    if "c.req.path.split('?')[0]" in content or 'c.req.path.split("?")[0]' in content:
        print("✓ 인증 미들웨어: 쿼리스트링 처리됨")
        return True
    else:
        print("✗ 인증 미들웨어: 쿼리스트링 미처리 (리다이렉트 루프 위험!)")
        return False

def check_site():
    """사이트가 정상 작동하는지 확인"""
    import urllib.request
    try:
        # /login.html은 200이어야 함 (리다이렉트 루프가 없어야 함)
        req = urllib.request.Request('https://myhub.myhub-app.workers.dev/login.html')
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status == 200:
                print("✓ 사이트: /login.html 200 OK (리다이렉트 루프 없음)")
                return True
            else:
                print(f"✗ 사이트: /login.html {r.status} (예상: 200)")
                return False
    except Exception as e:
        print(f"✗ 사이트 접속 실패: {e}")
        return False

def main():
    print("=== MyHub 배포 안전 검증 ===\n")
    results = []
    results.append(check_wrangler_toml())
    results.append(check_auth_middleware())
    results.append(check_site())
    
    print()
    if all(results):
        print("모든 체크 통과 ✓")
        return 0
    else:
        print("실패한 체크가 있습니다. 배포 전 수정 필요.")
        return 1

if __name__ == '__main__':
    sys.exit(main())
