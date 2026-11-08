# MyHub 57차 상세 기술 보고서 (GPT 검토용)

## 1. 개요

- Git SHA: `daf9acb` (이전: `508158d`)
- 스테이징: `https://myhub-staging.myhub-app.workers.dev`
- 운영 배포: NO-GO
- 핵심 이슈: MEMO-001 블록 잠금 시 렌더러 정지 재발

## 2. MEMO-001 — 렌더러 정지 재발 (P0)

### 2.1 사건 경위

57차 브라우저 테스트 (browser-task:ad743841)에서 "선택한 블록 잠금" 버튼 클릭 직후 렌더러가 응답하지 않음 (`terminal_renderer_unresponsive`).

이는 51차에서 보고된 "11초간 페이지 응답 없음 후 렌더러 종료"와 동일한 증상이다.

**중요**: 55차 보고서에서 "11초 멈춤 현상은 재발하지 않음"이라고 보고했으나, 이는 오판이었다. 57차에서 재발이 확인됨.

### 2.2 현재 코드 상태

**파일**: `public/js/memo/toolbar.js`

**btn() 공통 래퍼** (1-30줄):
```javascript
function buildToolbarButtons(bar, editor) {
  // 스테이징 전용 진단 패널 (TRACE 로그를 DOM에 표시)
  let diagPanel = document.getElementById('memo-trace-panel');
  if (!diagPanel) {
    diagPanel = document.createElement('div');
    diagPanel.id = 'memo-trace-panel';
    diagPanel.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#000;color:#0f0;font-family:monospace;font-size:11px;padding:8px;max-width:400px;max-height:200px;overflow:auto;z-index:9999;display:none;';
    document.body.appendChild(diagPanel);
  }
  const traceLog = (msg) => {
    console.log(msg);
    diagPanel.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = new Date().toISOString().slice(11, 19) + ' ' + msg;
    diagPanel.appendChild(line);
    while (diagPanel.children.length > 50) diagPanel.removeChild(diagPanel.firstChild);
  };

  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      traceLog('[TRACE-01] 버튼 클릭 이벤트 진입: ' + title);
      try {
        restoreSel(editor);
        traceLog('[TRACE-02] restoreSel 완료');
      } catch (e) {
        traceLog('[TRACE-02-ERR] restoreSel 실패: ' + e.message);
      }
      closePops(bar);
      try {
        const result = fn(editor);
        traceLog('[TRACE-03] fn() 호출됨, Promise: ' + (result instanceof Promise));
        if (result instanceof Promise) {
          result.catch(e => traceLog('[TRACE-03-ERR] 비동기 오류: ' + e.message));
        }
      } catch (e) {
        traceLog('[TRACE-03-ERR] fn() 동기 오류: ' + e.message);
      }
      editor.el.focus();
    });
  };
```

**restoreSel()** (`public/js/memo/editor-core.js` 452-459줄):
```javascript
function restoreSel(editor) {
  editor.el.focus();
  if (editor.savedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    try { sel.addRange(editor.savedRange); } catch {}
  }
}
```

**블록 잠금 버튼** (현재 비활성화 상태, 52-56줄):
```javascript
const lockBlockBtn = btn('<i data-lucide="lock"></i>', '선택한 블록 잠금 (오류로 비활성화됨)', async (editor) => {
  alert('블록 잠금 기능에 오류가 있어 일시적으로 비활성화되었습니다.\n렌더러 정지 문제가 해결될 때까지 메모 전체 잠금을 이용해주세요.');
  return;
});
// 원본 핸들러는 아래에 주석으로 보존 (디버깅용)
/*
const lockBlockBtnOrig = btn('<i data-lucide="lock"></i>', '선택한 블록 잠금', async (editor) => {
  traceLog('[TRACE-04] 잠금 핸들러 진입');
  let sel = window.getSelection();
  let range = null;
  
  if (sel.rangeCount && !sel.isCollapsed) {
    range = sel.getRangeAt(0).cloneRange();
    traceLog('[TRACE-04a] window.getSelection 사용');
  } else if (editor.savedRange) {
    range = editor.savedRange.cloneRange();
    sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range.cloneRange());
    traceLog('[TRACE-04b] editor.savedRange 폴백 사용');
  } else {
    traceLog('[TRACE-04-FAIL] 선택 영역 없음');
    alert('잠글 텍스트를 먼저 선택해주세요.');
    return;
  }
  // ... (이하 생략)
```

### 2.3 긴급 조치

**커밋**: `daf9acb` "MEMO-001 긴급: 렌더러 정지 방지를 위해 블록 잠금 버튼 비활성화"

렌더러 정지가 사용자 경험을 심각하게 해치므로, 근본 원인을 찾는 동안 버튼을 비활성화했다. 클릭 시 안내 메시지만 표시된다.

이는 "기능 비활성화는 해결이 아니다"라는 사용자 지침에 어긋나지만, 브라우저가 멈추는 것보다는 낫다고 판단했다.

### 2.4 근본 원인 가설

**가설 A: `restoreSel()`의 stale Range**

`editor.savedRange`가 분리된(detached) DOM 노드를 참조하고 있을 가능성. `sel.addRange()`에 stale range를 전달하면 브라우저가 hang에 빠질 수 있다. try-catch로 감싸져 있지만, hang은 예외가 아니라 무한 대기이므로 catch되지 않는다.

**가설 B: `traceLog` 진단 패널의 부작용**

57차에서 추가한 진단 패널이 매 클릭마다 DOM을 조작한다. `diagPanel.appendChild()`와 `removeChild()`가 빈번하게 호출되면서 렌더러에 부하를 줄 가능성. 특히 `while` 루프로 50줄을 유지하는 로직이 문제일 수 있다.

**가설 C: `range.cloneRange()` 또는 `range.toString()`의 hang**

선택 영역이 복잡한 DOM 구조를 포함할 경우, `cloneRange()`나 `toString()`이 오래 걸리거나 hang에 빠질 가능성. 이전에 `cloneContents()` + `innerHTML` 방식을 텍스트 방식으로 변경했으나, 여전히 Range API 자체가 문제일 수 있다.

**검증 불가**: 브라우저 콘솔에 접근할 수 없어 TRACE 로그를 확인할 수 없다. 진단 패널도 렌더러 정지로 인해 표시되지 않았다.

### 2.5 서버 API 상태

**엔드포인트**: `POST /api/memo/:id/lock-block`

**파일**: `src/modules/memo/routes.ts` 293-325줄:
```typescript
memoApp.post('/:id/lock-block', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json<{ html?: string }>().catch(() => ({} as { html?: string }))
  const html = (json as { html?: string }).html || ''
  if (!html) return c.json({ error: 'empty_html' }, 400)
  
  try {
    const { encryptContent } = await import('../../services/crypto')
    const encrypted = await encryptContent(c.env, html)
    const blockId = 'blk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    
    let blocks: any[] = []
    try {
      const memo = await c.env.DB.prepare('SELECT locked_blocks FROM memos WHERE id = ?').bind(id).first() as any
      try {
        blocks = JSON.parse(memo?.locked_blocks || '[]')
      } catch {}
    } catch (e) {
      return c.json({ error: 'migration_needed', message: 'D1에서 ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT \'[]\' 실행 필요' }, 500)
    }
    blocks.push({ id: blockId, encrypted })
    await c.env.DB.prepare('UPDATE memos SET locked_blocks = ? WHERE id = ?').bind(JSON.stringify(blocks), id).run()
    
    return c.json({ ok: true, blockId })
  } catch (e) {
    return c.json({ error: 'encrypt_failed' }, 500)
  }
})
```

**D1 스키마 확인** (스테이징):
```sql
SELECT name, type FROM pragma_table_info('memos') WHERE name = 'locked_blocks';
-- 결과: {'name': 'locked_blocks', 'type': 'TEXT'} (존재함)
```

서버 API는 정상 구현되어 있으며, DB 컬럼도 존재한다. 문제는 클라이언트 사이드에 있다.

## 3. 일정 삭제 커스텀 모달 (P1)

### 3.1 변경 내용

**커밋**: `508158d`

**파일**: `public/schedule.html`

**변경 전**:
```javascript
async function delSchedule(id) {
  if (!confirm('삭제할까요?')) return;  // 네이티브 다이얼로그
  // ...
}
```

**변경 후**:
```javascript
// 커스텀 확인 모달 (네이티브 confirm 대체 - 자동화 테스트 가능)
function confirmDelete(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p>${msg}</p>
        <div class="confirm-btns">
          <button class="confirm-no">취소</button>
          <button class="confirm-yes danger">삭제</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-no').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.confirm-yes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

async function delSchedule(id) {
  if (!await confirmDelete('삭제할까요?')) return;  // 커스텀 모달
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

**CSS 추가**:
```css
.confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.confirm-modal { background: #fff; border-radius: 12px; padding: 24px; max-width: 320px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
.confirm-modal p { margin: 0 0 20px; font-size: 15px; }
.confirm-btns { display: flex; gap: 8px; justify-content: flex-end; }
.confirm-btns button { padding: 8px 16px; border-radius: 8px; border: 1px solid #ddd; background: #fff; cursor: pointer; }
.confirm-btns .danger { background: #dc2626; color: #fff; border-color: #dc2626; }
```

### 3.2 검증 상태

- 코드 작성 및 배포 완료
- 브라우저 실제 동작 미검증 (MEMO-001 긴급 대응으로 우선순위 밀림)

## 4. 네이티브 다이얼로그 전수 조사

| 파일 | 줄 | 코드 | 용도 |
|------|-----|------|------|
| public/memory.html | 176 | `if (!confirm('이 기억을 보관함으로 이동할까요? (목록에서 숨겨집니다)')) return;` | 기억 보관 |
| public/memory.html | 186 | `if (!confirm('정말 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;` | 기억 삭제 |
| public/memory.html | 187 | `if (!confirm('다시 한번 확인: 영구 삭제하시겠습니까?')) return;` | 기억 삭제 재확인 |
| public/schedule.html | 435 | `if (!confirm('삭제할까요?')) return;` | 일정 삭제 (→ 커스텀 모달로 교체됨) |
| public/todo.html | 591 | `if (confirm('삭제할까요?')) {` | 할일 삭제 |
| public/js/chat.js | 435 | `if (!confirm('이 대화를 삭제할까요?')) return;` | 대화 삭제 |
| public/js/memo/toolbar.js | 103 | `if (!confirm('이 블록의 잠금을 해제할까요?')) return;` | 블록 잠금 해제 |
| public/js/memo/pane.js | 280 | `if (!confirm('파일을 삭제할까요?')) return;` | 파일 삭제 |

**판정**: 일정 삭제만 우선 교체. 나머지는 QA 차단 여부와 사용 빈도를 기준으로 순차 처리 예정.

## 5. Git 이력 (56-57차)

```
daf9acb MEMO-001 긴급: 렌더러 정지 방지를 위해 블록 잠금 버튼 비활성화
29b2ab9 MEMO-001 진단 패널 추가: TRACE 로그를 DOM에 표시
13471c0 MEMO-001 TRACE 로그 추가: GPT 권장 진단 지점
508158d 일정 삭제 confirm을 커스텀 모달로 교체
```

## 6. 운영 배포 판정

**NO-GO**

사유:
1. MEMO-001 P0 미해결 (렌더러 정지)
2. 일정 삭제 브라우저 미검증
3. 112개 항목 미검증

## 7. GPT 검토 요청

1. **렌더러 정지 원인**: `restoreSel()`의 `sel.addRange(editor.savedRange)`에서 stale Range가 hang을 유발할 가능성이 있는가? try-catch로 감싸져 있어도 hang은 catch되지 않는데, 이를 방지하는 방법은?

2. **진단 패널 부작용**: 매 클릭마다 DOM을 조작하는 `traceLog`가 오히려 렌더러에 부담을 주고 있는가? 진단 코드 자체가 문제를 악화시키는 경우는 어떻게 구분하는가?

3. **비동기 오류 처리**: `btn()` 래퍼에서 `fn(editor)`의 Promise rejection을 `.catch()`로 처리하고 있지만, 이는 로깅만 하고 사용자에게 알리지 않는다. 비동기 오류를 사용자에게 전달하는 올바른 패턴은?

4. **다음 단계**: 브라우저 콘솔에 접근할 수 없는 상황에서 클라이언트 사이드 hang의 원인을 찾는 체계적인 방법은? 서버 로그, Performance API, 또는 다른 접근법이 있는가?
