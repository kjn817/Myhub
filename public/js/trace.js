/* 트레이스 뷰어 — agent-prism 패턴 차용 (타임라인 렌더링만, 컴포넌트 복사 아님)
 * 데이터: GET /api/ai/traces (목록) · GET /api/ai/traces/:traceId (스팬)
 * 스팬 중첩(depth)·지연 막대(상대 시작~종료)·상태 색상을 보여준다.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtMs(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso || ''; }
  }

  function shortId(traceId) {
    return traceId ? traceId.slice(0, 12) + '…' : '';
  }

  async function loadTraces() {
    const el = document.getElementById('trace-list');
    el.innerHTML = '<div class="empty">불러오는 중…</div>';
    try {
      const res = await fetch('/api/ai/traces?limit=20');
      if (res.status === 401) { location.href = '/login.html'; return; }
      const body = await res.json();
      const traces = body.traces || [];
      if (traces.length === 0) {
        el.innerHTML = '<div class="empty">아직 트레이스가 없어요. 비서와 대화하면 여기에 남습니다.</div>';
        return;
      }
      el.innerHTML = traces.map((t) => `
        <div class="trace-item" data-trace-id="${esc(t.traceId)}">
          <div class="top"><span class="dot ${t.hasError ? 'error' : 'ok'}"></span><span class="id">${esc(shortId(t.traceId))}</span></div>
          <div class="meta">${esc(fmtTime(t.startedAt))} · 스팬 ${t.spanCount}개 · ${esc(fmtMs(t.totalMs))}${t.hasError ? ' · 오류 있음' : ''}</div>
        </div>`).join('');
    } catch (e) {
      el.innerHTML = '<div class="empty">불러오지 못했어요. 새로고침을 눌러주세요.</div>';
    }
  }

  async function openTrace(traceId) {
    document.getElementById('list-view').style.display = 'none';
    const detail = document.getElementById('detail-view');
    // 상세 보기의 초기 화면 CSS 규칙(#detail-view)에 해당하므로,
    // 보일 때는 인라인 값을 명시해야 한다 (''로 비우면 규칙으로 되돌아간다).
    detail.style.display = 'block';
    document.getElementById('detail-id').textContent = traceId;
    const tl = document.getElementById('timeline');
    tl.innerHTML = '<div class="empty">불러오는 중…</div>';
    try {
      const res = await fetch('/api/ai/traces/' + encodeURIComponent(traceId));
      if (res.status === 401) { location.href = '/login.html'; return; }
      const body = await res.json();
      const spans = body.spans || [];
      if (spans.length === 0) {
        tl.innerHTML = '<div class="empty">이 트레이스에 스팬이 없어요.</div>';
        document.getElementById('detail-meta').textContent = '';
        return;
      }
      // 상대 시간축: 가장 이른 시작(종료-소요)을 0으로 잡는다.
      const starts = spans.map((s) => Date.parse(s.endedAt) - (s.durationMs || 0));
      const ends = spans.map((s) => Date.parse(s.endedAt));
      const minStart = Math.min.apply(null, starts);
      const maxEnd = Math.max.apply(null, ends);
      const windowMs = Math.max(maxEnd - minStart, 1);
      const errCount = spans.filter((s) => s.status === 'error').length;
      document.getElementById('detail-meta').textContent =
        `스팬 ${spans.length}개 · ${fmtMs(maxEnd - minStart)}${errCount ? ` · 오류 ${errCount}개` : ''}`;
      tl.innerHTML = spans.map((s) => {
        const start = Date.parse(s.endedAt) - (s.durationMs || 0);
        const left = ((start - minStart) / windowMs) * 100;
        const width = Math.max(((s.durationMs || 0) / windowMs) * 100, 0.6);
        const indent = Math.min(s.depth || 0, 8) * 14;
        const kindLabel = s.kind === 'llm' ? 'LLM' : '도구';
        const tok = s.inputTokens != null || s.outputTokens != null
          ? ` · ${(s.inputTokens ?? '?')}/${(s.outputTokens ?? '?')} 토큰` : '';
        const pv = s.promptVersion ? ` · ${esc(s.promptVersion)}` : '';
        return `<div class="span-row">
          <div class="span-label" style="padding-left:${indent}px"><span class="kind">${kindLabel}</span>${esc(s.name)}<span class="tok">${tok}${pv}</span></div>
          <div class="span-track"><div class="span-bar ${esc(s.status)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div></div>
          <div class="span-dur">${esc(fmtMs(s.durationMs))}</div>
        </div>`;
      }).join('');
    } catch (e) {
      tl.innerHTML = '<div class="empty">불러오지 못했어요.</div>';
    }
  }

  function showList() {
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('list-view').style.display = '';
  }

  // 배선은 전부 addEventListener로 건다 (CSP script-src-attr 'none' 전제,
  // 2026-11-01 파일). 분리 목록 항목 innerHTML클릭은 로다시 그려지므로
  // 항목마다 핸들러를 붙이지 않고 컨테이너에 위임한다.
  document.getElementById('refreshBtn').addEventListener('click', loadTraces);
  document.getElementById('backBtn').addEventListener('click', showList);
  document.getElementById('trace-list').addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.trace-item') : null;
    if (item) openTrace(item.dataset.traceId);
  });

  loadTraces();
})();
