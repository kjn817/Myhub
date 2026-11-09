/* MyHub 파인더 코덱 (finder-codec.js) 등 순수 변환 모음 (2026-11-02 분리)
 *
 * finder-viewer.js가 500줄 규칙을 넘어, DOM상태와 무관한 순수 함수를
 * 분리한다: 파일 분류, CSV 파싱/직렬화, 텍스트 인코딩 판정(UTF-8/EUC-KR),
 * HWPX 본문 텍스트 추출. 코어의 등 전역은 먼저 로드된 별칭으로 이룬다
 * (finder.html로드office.html 순 서의 테스트 VIEWER_FILES가 보장).
 * 노출: window.MyHubFinderCodec = { extOf, classifyFile, parseCsv,
 *        serializeCsv, decodeTextBytes, encodeText, extractHwpxText }
 */
(function () {
  'use strict';

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function classifyFile(name, mime) {
    var ext = extOf(name);
    mime = String(mime || '');
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0)
      return 'image';
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (ext === 'csv') return 'csv';
    if (ext === 'xlsx') return 'xlsx';
    if (ext === 'xls') return 'xls';
    if (ext === 'hwpx') return 'hwpx';
    if (ext === 'hwp') return 'hwp';
    if (ext === 'pptx') return 'pptx';
    if (ext === 'docx') return 'docx';
    if (['txt', 'md', 'markdown', 'json', 'log', 'tsv', 'xml', 'html', 'css', 'js'].indexOf(ext) >= 0)
      return 'text';
    if (mime.indexOf('text/') === 0) return 'text';
    return 'download';
  }

  /** 따옴표 아는 최소 CSV 파서 */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQ = false;
    var s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else inQ = false;
        } else field += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /**
   * opts = { eol, trailingEol } 원본 파 일의 줄바꿈(CRLF/LF)과 말단 개행
   * 유지를 그림으로 되돌리고, 고치지 않는 행까지 바이트가 사라지 않게 한다
   * (감사 D11). opts가 없으면 기존 동작(LF, 말단 개행 없음).
   */
  function serializeCsv(rows, opts) {
    var eol = (opts && opts.eol) || '\n';
    var out = rows
      .map(function (row) {
        return row
          .map(function (cell) {
            var v = String(cell === null || cell === undefined ? '' : cell);
            return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
          })
          .join(',');
      })
      .join(eol);
    if (opts && opts.trailingEol && rows.length) out += eol;
    return out;
  }

  /**
   * 텍스트 바이트의 인코딩 판별 (감사 D2 등 데이터 이상 방어).
   * UTF-8 BOM가 있으면 UTF-8로, 아니면 엄격(fatal) UTF-8 디코딩을 시도하고
   * 실패하면 EUC-KR로 읽는다. 반환: { text, encoding, bom }.
   * 판별한 인코딩 파일 등 encodeText로 그림으로 되돌릴 정확히 무손실으로 만든다.
   */
  function decodeTextBytes(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var bom =
      bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try {
      // TextDecoder가 BOM기본으로 실패 하므로 bom 플래그로만 기억한다
      var text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text: text, encoding: 'utf-8', bom: bom };
    } catch (e) {
      return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr', bom: false };
    }
  }

  var eucKrEncodeMap = null; // 지연 구축 등 EUC-KR로 저장할 때 필요한 번만

  /**
   * EUC-KR 인코딩 맵을 디코딩에 쓴다 (브라우저 EUC-KR 인코딩이
   * 없어서, 가능한 모든 2바이트 쌍을 디코딩해 문자맵을 실시한다).
   * 한계는 입력 디코딩이 상태 실패에 앉고, 중복 문자의 첫 코드가 숨긴다.
   */
  function buildEucKrEncodeMap() {
    var map = new Map();
    var dec = new TextDecoder('euc-kr');
    for (var lead = 0x81; lead <= 0xfe; lead++) {
      for (var trail = 0x41; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        var ch = dec.decode(new Uint8Array([lead, trail]));
        if (ch.length === 1 && ch !== '\uFFFD' && !map.has(ch)) {
          map.set(ch, [lead, trail]);
        }
      }
    }
    return map;
  }

  function encodeEucKr(str) {
    if (!eucKrEncodeMap) eucKrEncodeMap = buildEucKrEncodeMap();
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
        continue;
      }
      var ch = str[i];
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        ch = str.substr(i, 2); // 서로게이트 쌍 등 기호로
        i++;
      }
      var pair = eucKrEncodeMap.get(ch);
      if (pair) bytes.push(pair[0], pair[1]);
      else bytes.push(0x3f); // '?' 등 EUC-KR로 표현할 수 없는 문자
    }
    return new Uint8Array(bytes);
  }

  /** decodeTextBytes의 역인 대변 인코딩 (BOM 복원 포함) */
  function encodeText(text, encoding, bom) {
    var body =
      encoding === 'euc-kr' ? encodeEucKr(String(text)) : new TextEncoder().encode(String(text));
    if (bom && encoding === 'utf-8') {
      var out = new Uint8Array(body.length + 3);
      out[0] = 0xef;
      out[1] = 0xbb;
      out[2] = 0xbf;
      out.set(body, 3);
      return out;
    }
    return body;
  }

  /** HWPX section XML에서 본문 텍스트만 뽑는다 (문단 = 줄바꿈) */
  function extractHwpxText(xml) {
    var s = String(xml || '');
    s = s.replace(/<\/hp:p>/g, '\n');
    var out = [];
    var re = /<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g;
    var lines = s.split('\n');
    lines.forEach(function (line) {
      var parts = [];
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) parts.push(m[1]);
      out.push(parts.join(''));
    });
    return out
      .join('\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  var api = {
    extOf: extOf,
    classifyFile: classifyFile,
    parseCsv: parseCsv,
    serializeCsv: serializeCsv,
    decodeTextBytes: decodeTextBytes,
    encodeText: encodeText,
    extractHwpxText: extractHwpxText,
  };
  if (typeof window !== 'undefined') window.MyHubFinderCodec = api;
  if (typeof globalThis !== 'undefined') globalThis.MyHubFinderCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
