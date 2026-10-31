/* ================= 1. 유틸 ================= */
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtSize(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b/1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + 'MB';
  return (b/1073741824).toFixed(2) + 'GB';
}

function fmtDate(s) {
  const d = new Date(s + (s.endsWith('Z') ? '' : 'Z'));
  const now = new Date();
  const diff = now - d;
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff < 60e3) return '방금 전';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + '분 전';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return '오늘 ' + hm;
  if (days === 1) return '어제 ' + hm;
  if (days < 7) return days + '일 전';
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
function highlight(text, q) {
  let out = esc(text);
  if (!q.trim()) return out;
  q.trim().split(/\s+/).forEach(tok => {
    if (!tok) return;
    const re = new RegExp('(' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}
const IMG_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg','avif','tif','tiff','ico','heic','heif','jfif','pjp','pjpeg'];
function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['xls','xlsx','csv'].includes(ext)) return 'file-spreadsheet';
  if (['doc','docx','hwp','txt','md','rtf'].includes(ext)) return 'file-text';
  if (ext === 'pdf') return 'file';
  if (['zip','rar','7z','tar','gz','bz2'].includes(ext)) return 'file-archive';
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'file-audio';
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'file-video';
  if (['ppt','pptx','key'].includes(ext)) return 'presentation';
  return 'paperclip';
}
function isImage(mime, name) {
  if ((mime || '').toLowerCase().startsWith('image/')) return true;
  const ext = String(name || '').split('.').pop().toLowerCase().split('?')[0];
  return IMG_EXTS.includes(ext);
}
function extractTags(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/#([가-힣a-zA-Z0-9_]+)/g)) set.add(m[1]);
  return [...set];
}
// 인라인 이미지 마커: ![이름](file:123), 너비 포함 시 ![이름|300](file:123)
function markerIds(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/!\[.*?\]\(file:(\d+)\)/g)) set.add(Number(m[1]));
  return set;
}
function parseMarkerAlt(alt) {
  const m = /^(.*)\|(\d+)$/.exec(alt);
  return m ? { alt: m[1], width: +m[2] } : { alt, width: 0 };
}

// 메모 텍스트에서 제목과 본문 분리
function extractTitle(text) {
  if (!text) return { title: '', body: '' };
  const lines = String(text).split('\n');
  const firstLine = (lines[0] || '').trim();
  // 첫 줄이 짧으면 제목으로
  if (firstLine && firstLine.length <= 60 && lines.length > 1) {
    return { title: firstLine, body: lines.slice(1).join('\n').trim() };
  }
  return { title: '', body: text };
}
