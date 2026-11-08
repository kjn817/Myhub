# DEPLOY-003 실제 실행 절차서

## 목적
Cloudflare Versions API를 사용한 안전한 배포 검증

## 사전 조건
- 실행 환경: `dynamic_credentials` 모듈 제공 환경
- 대상: 스테이징 Worker (`myhub-staging`)
- 권한: Workers Scripts Write

## 절차

### 1. 현재 상태 조회

```bash
# Python에서 실행
python3 << 'EOF'
from deploy_safe import upload_version_api
# GET /versions로 현재 활성 버전 확인
# GET /deployments로 트래픽 비율 확인
EOF
```

기록:
- [ ] 현재 활성 Version ID: _______________
- [ ] 트래픽 비율: _______________
- [ ] Git SHA: _______________

### 2. 후보 버전 업로드

```bash
python3 deploy_safe.py staging --dry-run  # 먼저 dry-run
python3 deploy_safe.py staging            # 실제 업로드
```

**주의**: 이 단계에서는 POST /deployments를 호출하지 않음.

기록:
- [ ] HTTP 상태: _______________
- [ ] API success: _______________
- [ ] 신규 Version ID: _______________
- [ ] 오류: _______________

### 3. 트래픽 불변 확인

업로드 직후 GET /deployments 재실행.

- [ ] 기존 활성 Version ID 유지: YES / NO
- [ ] 트래픽 비율 유지: YES / NO

**FAIL 조건**: 트래픽이 변경되면 즉시 중단.

### 4. 후보 검증

Version URL에서 직접 검증:
- [ ] HTTP 200
- [ ] 후보 버전 식별 일치
- [ ] chat.js SEC-001 수정 포함
- [ ] MEMO-001 비활성화 포함

### 5. 승격 (검증 통과 시에만)

모든 검증 PASS 후:
```bash
# POST /deployments with version_id@100%
```

## 중단 조건
- 인증 실패
- 업로드 실패
- 트래픽 변경
- 검증 실패

## 증거 제출
- 각 단계의 실제 출력
- Version ID 목록
- 트래픽 비교 표
