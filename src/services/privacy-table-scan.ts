import type { PrivacySpan } from './privacy-engine';

const PW_TABLE_LABELS = ['비밀번호', '패스워드', '비번', 'password', 'passwd', 'passcode', 'pwd', 'pw'];
const PW_TABLE_LABEL_SUFFIXES = new Set(['확인', '재확인', '입력', '란', '필드', '번호', '값', 'confirm', 'check', 'field']);
const PW_TABLE_PLACEHOLDERS = new Set([
  '없음',
  '미설정',
  '해당없음',
  '미입력',
  '미정',
  '공란',
  '미등록',
  'null',
  'none',
  'n/a',
  'na',
  '-',
  '*',
  '**',
  '***',
]);

function isPasswordColumnLabel(cell: string): boolean {
  const norm = cell.trim().toLowerCase().replace(/[\s_\-()\[\]{}<>:：·.]/g, '');
  if (!norm) return false;
  for (const label of PW_TABLE_LABELS) {
    if (norm === label) return true;
    if (label.length >= 4 && norm.startsWith(label) && PW_TABLE_LABEL_SUFFIXES.has(norm.slice(label.length))) return true;
  }
  return false;
}

function tableDelimOf(line: string): string | null {
  if (line.includes('\t')) return '\t';
  if (line.includes(',')) return ',';
  if (/ {2,}/.test(line)) return 'spaces';
  return null;
}

function splitTableLine(line: string, delim: string): Array<{ value: string; start: number; end: number }> {
  if (delim === 'spaces') {
    const out: Array<{ value: string; start: number; end: number }> = [];
    const re = /[^ ]+(?: [^ ]+)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) out.push({ value: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }
  const raws: Array<{ raw: string; start: number }> = [];
  let cellStart = 0;
  let inQuotes = false;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (i === line.length || (line[i] === delim && !inQuotes)) {
      raws.push({ raw: line.slice(cellStart, i), start: cellStart });
      cellStart = i + 1;
    }
  }
  return raws.map(({ raw, start }) => {
    let s = start + (raw.length - raw.trimStart().length);
    let core = raw.trim();
    if (core.length >= 2 && core.startsWith('"') && core.endsWith('"')) {
      s += 1;
      core = core.slice(1, -1).replace(/""/g, '"');
      const lead = core.length - core.trimStart().length;
      s += lead;
      core = core.trim();
    }
    return { value: core, start: s, end: s + core.length };
  });
}

export function scanTablePasswords(text: string): PrivacySpan[] {
  const out: PrivacySpan[] = [];
  const lines: Array<{ text: string; start: number }> = [];
  let off = 0;
  for (const part of text.split('\n')) {
    lines.push({ text: part.replace(/\r$/, ''), start: off });
    off += part.length + 1;
  }
  for (let h = 0; h < lines.length; h++) {
    const delim = tableDelimOf(lines[h].text);
    if (!delim) continue;
    const headerCells = splitTableLine(lines[h].text, delim);
    if (headerCells.length < 2) continue;
    const pwCols = headerCells.flatMap((c, i) => (isPasswordColumnLabel(c.value) ? [i] : []));
    if (pwCols.length === 0) continue;
    for (let r = h + 1; r < lines.length; r++) {
      const row = lines[r];
      if (!row.text.trim() || tableDelimOf(row.text) !== delim) break;
      const cells = splitTableLine(row.text, delim);
      for (const col of pwCols) {
        const cell = cells[col];
        if (!cell) continue;
        const value = cell.value;
        if (value.length < 4) continue;
        if (PW_TABLE_PLACEHOLDERS.has(value.toLowerCase())) continue;
        if (isPasswordColumnLabel(value)) continue;
        const start = row.start + cell.start;
        out.push({ type: 'PASSWORD', level: 3, start, end: row.start + cell.end, value: text.slice(start, row.start + cell.end) });
      }
    }
  }
  return out;
}
