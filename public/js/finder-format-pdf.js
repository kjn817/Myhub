/* Finder 뷰어 포맷: PDF — 오피스 PDF 앱(iframe)으로 교체, 무응답 시 네이티브 폴백.
 *
 * 재구성 근거: 본문을 PDF 앱 iframe으로 교체하고 ready 신호를 기다린다.
 * 20초 무응답이면 네이티브 임베드(Blob URL)로 폴백하며 고지한다.
 * ctx.fetchRaw로 원본을 받아 폴백에 쓴다. canSave=true — 저장은 앱에 위임.
 * ownsChrome=true.
 */
(function () {
  'use strict';
  var V = window.FinderViewer;
  if (!V) return;

  var READY_TIMEOUT_MS = 20000;

  V.registerFormat('pdf', {
    render: function (body, file, ctx) {
      body.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'fv-pdf';
      var frame = document.createElement('iframe');
      frame.className = 'fv-pdf-frame';
      frame.title = file.name || 'PDF';
      frame.src = '/office.html?app=pdf&file=' + encodeURIComponent(file.id);
      wrap.appendChild(frame);
      body.appendChild(wrap);

      var ready = false;
      var disposed = false;
      var objectUrl = null;

      function onMessage(ev) {
        if (ev.origin !== window.location.origin) return;
        if (ev.source !== frame.contentWindow) return;
        var d = ev.data;
        if (d && d.type === 'myhub:pdf-ready') {
          ready = true;
          clearTimeout(timer);
        }
      }
      window.addEventListener('message', onMessage);

      var timer = setTimeout(function () {
        if (ready || disposed) return;
        // 네이티브 임베드 폴백 + 고지
        ctx.fetchRaw().then(function (buf) {
          if (disposed) return;
          objectUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
          wrap.innerHTML = '';
          var note = document.createElement('div');
          note.className = 'fv-note';
          note.textContent = 'PDF 앱이 응답하지 않아 기본 보기로 열었어요. 편집은 되지 않아요.';
          var embed = document.createElement('embed');
          embed.className = 'fv-pdf-frame';
          embed.type = 'application/pdf';
          embed.src = objectUrl;
          wrap.appendChild(note);
          wrap.appendChild(embed);
        }).catch(function () {
          wrap.innerHTML = '<div class="fv-empty">PDF를 열지 못했어요.</div>';
        });
      }, READY_TIMEOUT_MS);

      return {
        canSave: true,
        ownsChrome: true,
        save: function () {
          return new Promise(function (resolve) {
            if (!ready || !frame.contentWindow) {
              resolve({ conflict: false, skipped: true });
              return;
            }
            var done = function (ev) {
              if (ev.origin !== window.location.origin) return;
              if (ev.source !== frame.contentWindow) return;
              var d = ev.data;
              if (d && d.type === 'myhub:pdf-save-result') {
                window.removeEventListener('message', done);
                resolve(d.conflict ? { conflict: true } : { ok: true });
              }
            };
            window.addEventListener('message', done);
            frame.contentWindow.postMessage({ type: 'myhub:pdf-save' }, window.location.origin);
            setTimeout(function () {
              window.removeEventListener('message', done);
              resolve({ ok: true });
            }, 10000);
          });
        },
        dispose: function () {
          disposed = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        },
      };
    },
  });
})();
