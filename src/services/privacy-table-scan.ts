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
  // NFKC(전각 영문 등)와 보이지 않는 형식 문자를 먼저 펴야 라벨 변형이
  // 열 인식을 빠져나가지 못한다 (엔진 정규화와 같은 부류의 우회 방지).
  const norm = cell
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-()\[\]{}<>:：·.]/g, '');
  if (!norm) return false;
  for (const label of PW_TABLE_LABELS) {
    if (norm === label) return true;
    if (label.length >= 4 && norm.startsWith(label) && PW_TABLE_LABEL_SUFFIXES.has(norm.slice(label.length))) return true;
  }
  return false;
}

function tableDelimOf(line: string): string | null {
  if (line.includes('\t')) return '\t';
  // 마크다운 행은 '|'로 시작한다 — 셀 값에 쉼표가 있어도 행 구분자가 우선.
  if (line.trimStart().startsWith('|')) return '|';
  if (line.includes(',')) return ',';
  if (line.includes(';')) return ';';
  if (line.includes('|')) return '|';
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
  // 따옴표는 셀 시작(앞 공백만 있는 위치)에서만 인용 부호로 취급한다 (CSV
  // 관례). 셀 중간 값에 우연히 들어간 따옴표까지 토글로 보면 그 뒤
  // 구분자가 삼켜져 열이 밀리고 비밀번호 열이 통째로 빗나간다.
  let atCellPrefix = true;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && line[i] === '"') {
      if (inQuotes) {
        if (line[i + 1] === '"') {
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (atCellPrefix) {
        inQuotes = true;
        continue;
      }
    }
    if (i === line.length || (line[i] === delim && !inQuotes)) {
      raws.push({ raw: line.slice(cellStart, i), start: cellStart });
      cellStart = i + 1;
      atCellPrefix = true;
      continue;
    }
    if (line[i] !== ' ') atCellPrefix = false;
  }
  return raws.map(({ raw, start }) => {
    let s = start + (raw.length - raw.trimStart().length);
    let core = raw.trim();
    if (core.length >= 2 && core.startsWith('"') && core.endsWith('"')) {
      s += 1;
      const innerRaw = core.slice(1, -1);
      core = innerRaw.replace(/""/g, '"');
      const lead = core.length - core.trimStart().length;
      s += lead;
      core = core.trim();
      // end는 원본 좌표로 계산한다 — 이스케이프 해제 후의 길이를 쓰면
      // "" 쌍마다 구간이 짧아져 비밀의 끝 글자가 마스킹 밖에 남는다.
      return { value: core, start: s, end: s + innerRaw.trim().length };
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
      // 행은 헤더의 구분자를 포함하는지로 판정한다 — 셀 값 안에 다른
      // 구분자(금액의 쉼표 등)가 있어도 행이 끊기지 않게 하기 위해서다.
      const rowHasDelim = delim === 'spaces' ? / {2,}/.test(row.text) : row.text.includes(delim);
      if (!row.text.trim() || !rowHasDelim) break;
      const cells = splitTableLine(row.text, delim);
      // 마크다운 정렬 행(| --- | --- |)은 데이터 행이 아니다.
      if (cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.value))) continue;
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
