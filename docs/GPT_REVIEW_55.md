# MyHub 55차 상세 결과 보고서 (GPT 검토용)

## 1. 개요

- 기간: 2026-10-12 17:00~17:26 KST
- Git SHA: `fc5b3af` → `2248e90`
- 스테이징: `https://myhub-staging.myhub-app.workers.dev`
- 운영 배포: NO-GO 유지

## 2. 테스트 방법론 변경

사용자 지시에 따라 브라우저 태스크 관리 방식을 변경:
- 이전: 여러 태스크를 병렬로 실행하고 닫지 않음 → 슬롯 고갈 → `browser_slot_retired` 오류
- 변경: 하나의 태스크만 실행 → 완료 후 즉시 `browser.close_task` → 다음 태스크 실행

이 변경 후 브라우저 안정성이 개선됨.

## 3. 일정 저장 (SCHED-001) — PASS

### 3.1 근본 원인

**파일**: `public/schedule.html` 417줄

**코드**:
```javascript
var payload = {
  title: $('fTitle').value.trim(),
  start_at: $('fStart').value ? $('fStart').value.slice(0, 16) : '',
  // ...
  status: $('fStatus').value  // ← 문제
};
```

**문제**: HTML에 `id="fStatus"` 요소가 존재하지 않음. `$('fStatus')`가 `null`을 반환하고, `null.value` 접근 시 TypeError 발생. 이 코드가 try-catch 블록 밖에 있어 예외가 조용히 전파되고, 저장 버튼이 무반응 상태가 됨.

**수정** (`fc5b3af`):
```javascript
var payload = {
  title: $('fTitle').value.trim(),
  start_at: $('fStart').value ? $('fStart').value.slice(0, 16) : '',
  end_at: $('fEnd').value ? $('fEnd').value.slice(0, 16) : null,
  location: $('fLocation').value.trim(),
  description: $('fDesc').value.trim(),
  recurrence_rule: $('fRrule').value.trim() || null
  // status 필드 제거
};
```

### 3.2 브라우저 검증 (태스크 ID: browser-task:c5ff507f)

**절차**:
1. "일정 추가" 클릭 → 다이얼로그 열림 ✅
2. 제목 "55차저장테스트" 입력 ✅
3. 시작 시간: 기본값 2026-10-12 21:00 사용 ✅
4. 저장 클릭 → 다이얼로그 닫힘 ✅
5. 목록에 "55차저장테스트" 표시 (21:00) ✅
6. 새로고침 → 일정 유지 ✅

**판정**: PASS

**테스트 데이터**: "55차저장테스트" 일정이 스테이징에 남아있음 (정리 필요)

### 3.3 추가 확인 사항

- `status` 필드가 API에서 필수인지 미확인. 현재 제거된 상태로 정상 작동하므로 필수 아님으로 추정.
- 서버 기본값 동작 미확인.

## 4. 일정 삭제 — NOT TESTED (테스트 불가)

### 4.1 시도 내용

브라우저 태스크 (browser-task:8d7d1cfc)로 삭제 테스트 시도:
1. 목록에서 "55차저장테스트" 일정 확인 ✅
2. 삭제 버튼 클릭 → `browser_slot_retired`로 태스크 실패 ❌

### 4.2 실패 원인 분석

**코드** (`public/schedule.html` 434-444):
```javascript
async function delSchedule(id) {
  if (!confirm('삭제할까요?')) return;  // ← 네이티브 다이얼로그
  try {
    await api('/api/schedule/' + id, { method: 'DELETE' });
    monthCache = {};
    await loadMonth(viewY, viewM);
    render();
  } catch (e) {
    alert('삭제 실패: ' + (e.message || '알 수 없는 오류'));
  }
}
```

**문제점**: `confirm()`은 네이티브 브라우저 다이얼로그로, 자동화 테스트에서 처리할 수 없음. 다이얼로그가 뜨면 렌더러가 응답하지 않는 것으로 감지되어 태스크가 강제 종료됨.

**사용자 지적**: "테스트가 불가하면 문제있는거아냐?"

**답변**: 맞음. 이는 테스트 가능성(testability) 결함임. 네이티브 `confirm()`/`alert()`를 사용하는 코드는 자동화 테스트가 불가능. 커스텀 모달로 교체해야 함 (메모 삭제는 이미 커스텀 모달로 교체됨 - 2026-10-09).

### 4.3 권장 조치

1. `confirm()`을 커스텀 모달로 교체 (메모 삭제와 동일한 패턴)
2. 삭제 API (`DELETE /api/schedule/:id`)의 단위 테스트 추가
3. 수동 테스트로 삭제 기능 확인 (현재 미수행)

## 5. 메모 블록 잠금 (MEMO-001) — FAIL

### 5.1 현재 상태

**이전 수정**:
- `5d73f00`: 텍스트 기반 잠금으로 변경 (DOM 파싱 오버헤드 제거) → 11초 멈춤 해결
- `2248e90`: `editor.savedRange` 폴백 추가 (선택 영역 확보 개선)

**브라우저 검증** (browser-task:f7911088):
1. 새 메모 "잠금재테스트" 생성 ✅
2. 편집 모드로 열기 ✅
3. "테스트합니다." 선택 ✅
4. "선택한 블록 잠금" 버튼 클릭 (2회) ✅
5. 결과: 알림 없음, 화면 변화 없음 ❌

### 5.2 실패 지점 분석 (추정)

**클라이언트 코드** (`public/js/memo/toolbar.js`):
```javascript
const lockBlockBtn = btn('<i data-lucide="lock"></i>', '선택한 블록 잠금', async (editor) => {
  let sel = window.getSelection();
  let range = null;
  
  if (sel.rangeCount && !sel.isCollapsed) {
    range = sel.getRangeAt(0).cloneRange();
  } else if (editor.savedRange) {
    range = editor.savedRange.cloneRange();
    // ...
  } else {
    alert('잠글 텍스트를 먼저 선택해주세요.');
    return;
  }
  // ...
```

**가설 1**: `btn()` 래퍼의 `restoreSel(editor)`에서 예외 발생
```javascript
const b = document.createElement('button');
b.addEventListener('click', () => {
  restoreSel(editor);  // ← 여기서 예외 발생 시 fn() 호출 안 됨
  closePops(bar);
  fn(editor);
  editor.el.focus();
});
```

**가설 2**: `editor` 객체가 null이거나 `editor.el`이 없음

**가설 3**: 핸들러가 연결되지 않음 (초기화 시 오류)

**차단 요인**: 브라우저 태스크에서 개발자 도구 콘솔에 접근 불가. `console.log` 출력, 변수 값, Network 요청을 확인할 수 없음.

### 5.3 서버 API 상태

**엔드포인트**: `POST /api/memo/:id/lock-block` (`src/modules/memo/routes.ts:293`)

**구현 상태**: 정상 구현됨
- 요청 본문의 `html` 필드 검증
- `encryptContent()`로 암호화
- `locked_blocks` 컬럼에 JSON으로 저장
- `{ok: true, blockId}` 반환

**마이그레이션**: `migrations/0015_block_lock.sql` 존재
```sql
ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]';
```

**미확인**: 스테이징 D1에 `locked_blocks` 컬럼이 실제로 존재하는지 미확인.

### 5.4 권장 조치

1. 브라우저 개발자 도구에서 직접 디버깅 (콘솔 에러 확인)
2. `btn()` 래퍼에 try-catch 추가하여 초기화 오류 격리
3. 잠금 버튼 핸들러에 디버그 로그 추가
4. 스테이징 D1 스키마 확인: `SELECT sql FROM sqlite_master WHERE name='memos'`

## 6. DOM 참조 불일치 전수 검사 — PASS (정적)

### 6.1 방법

Python 스크립트로 10개 HTML 파일 전체 검사:
- JavaScript 참조: `$('...')`, `getElementById('...')`
- HTML 정의: `id="..."`
- 불일치 탐지

### 6.2 결과

불일치 0건 (fStatus 수정 후)

### 6.3 한계

정적 분석만으로는 다음을 탐지할 수 없음:
- 동적으로 생성되는 요소
- 조건부 렌더링
- 실행 시점의 null 참조
- 비동기 타이밍 이슈

실제 브라우저에서의 동적 검사가 필요하나, 콘솔 접근 불가로 제한됨.

## 7. QA 통계

| 구분 | 수량 | 비고 |
|------|------|------|
| PASS | 53 | 일정 저장 추가 |
| FAIL | 1 | MEMO-001 블록 잠금 기능 미완성 |
| NOT TESTED | 112 | 일정 삭제 포함 |
| **합계** | **166** | |

## 8. Git 이력 (55차)

```
2248e90 P0 MEMO-001: editor.savedRange 폴백 추가로 선택 영역 확보 개선
fc5b3af P1 일정 저장 근본 수정: 존재하지 않는 fStatus 참조 제거
7942cbb 배포 검증 로직 개선
```

## 9. 스테이징 상태

- Worker: 배포됨 (버전 확인 필요)
- 테스트 데이터 정리 필요:
  - "55차저장테스트" 일정
  - "55차수정됨" 일정 (이전 테스트)
  - "잠금재테스트" 메모
  - "디버깅테스트" 메모
  - "블록잠금테스트" 메모

## 10. 운영 배포 판정

**NO-GO**

사유:
1. MEMO-001 P0 미해결 (버튼 무반응)
2. 일정 삭제 미검증 (테스트 불가 = 테스트 가능성 결함)
3. 112개 항목 미검증 (67%)

## 11. GPT 검토 요청 사항

1. **MEMO-001**: `btn()` 래퍼와 `restoreSel()`의 상호작용에서 핸들러가 실행되지 않는 원인을 코드 리뷰로 파악 가능한가?

2. **테스트 가능성**: `confirm()`/`alert()`를 커스텀 모달로 교체하는 리팩터링의 우선순위는? 일정 삭제 외에 다른 곳에서도 네이티브 다이얼로그를 사용하는지 전수 조사가 필요한가?

3. **112개 미검증**: 제한된 브라우저 테스트 리소스로 전체 QA를 완료하는 전략은? API 직접 테스트로 커버 가능한 범위와 반드시 브라우저가 필요한 범위의 구분 기준은?

4. **스테이징 D1**: `locked_blocks` 컬럼 존재 여부를 확인하는 안전한 방법은? (운영에는 영향 없음)
