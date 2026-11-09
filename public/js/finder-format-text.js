// 파인더 뷰어 플러그 모듈 등 텍스트/CSV (finder-format-text.js)
// 코어(finder-viewer.js)의 text핸들csv 러를 등록한다.
// 엔 진과(D2)줄 바꿈 정보(D11)의 코어의 순수 함수를 낸다.
(function () {
  'use strict';
  var core = typeof window !== 'undefined' ? window.MyHubFinderViewer : null;
  if (!core) return;

  function handleText(ctx) {
    return ctx.fetchContent('buffer').then(function (buf) {
      if (!ctx.isCurrent()) return;
      var dec = core.decodeTextBytes(buf);
      ctx.openTextEditor(dec.text, function (value) {
        var bytes = core.encodeText(value, dec.encoding, dec.bom);
        return ctx.putContent(new Blob([bytes], { type: 'text/plain' }));
      });
    });
  }

  function handleCsv(ctx) {
    return ctx.fetchContent('buffer').then(function (buf) {
      if (!ctx.isCurrent()) return;
      var dec = core.decodeTextBytes(buf);
      var text = dec.text;
      // 원본 줄바꿈대로 개별 기억한 파일을 등 그대로 되돌린다 (D11)
      var eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
      var trailingEol = /\n$/.test(text);
      var aoa = core.parseCsv(text);
      if (aoa.length > 300) {
        ctx.setNote('행이 많아 텍스트로 편집합니다');
        ctx.openTextEditor(text, function (value) {
          var bytes = core.encodeText(value, dec.encoding, dec.bom);
          return ctx.putContent(new Blob([bytes], { type: 'text/csv' }));
        });
        return;
      }
      ctx.clearBody();
      ctx.body.appendChild(
        ctx.buildGrid(aoa, function (r, c, value) {
          aoa[r][c] = value;
        }),
      );
      if (ctx.saveBtn) ctx.saveBtn.hidden = false;
      ctx.setSaveHandler(function () {
        var out = core.serializeCsv(aoa, { eol: eol, trailingEol: trailingEol });
        var bytes = core.encodeText(out, dec.encoding, dec.bom);
        return ctx.putContent(new Blob([bytes], { type: 'text/csv' }));
      });
    });
  }

  core.registerFormat('text', handleText);
  core.registerFormat('csv', handleCsv);

  var api = { handleText: handleText, handleCsv: handleCsv };
  if (typeof window !== 'undefined') window.MyHubFinderFormatText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
