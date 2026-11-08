# Phase 4B 수동 테스트 체크리스트

## 스테이징 URL
https://myhub-staging.myhub-app.workers.dev/search.html

## 로그인
1. https://myhub-staging.myhub-app.workers.dev/login.html 접속
2. kjn817@gmail.com로 OTP 요청
3. 코드 입력 후 로그인

## 검색 테스트
- [ ] 검색어 입력 후 결과 표시
- [ ] 전체/메모/대화/일정/할 일 필터 동작
- [ ] 한국어 검색어 동작
- [ ] 검색 결과 없음 표시
- [ ] 잠금 메모가 결과에 없음
- [ ] XSS 문자열이 텍스트로 표시됨

## 대시보드 연결
- [ ] 메인 화면에서 "통합 검색" 링크 표시
- [ ] 클릭 시 /search.html로 이동
