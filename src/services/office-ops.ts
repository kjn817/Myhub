import { MAX_OPS } from './office-ops-shared';

export type SheetCellValue = string | number | boolean | null;
export type SheetCellInput = { value: SheetCellValue } | { formula: string };

export type SheetOp =
  | ({ type: 'set_cell'; cell: string } & SheetCellInput)
  | { type: 'set_range'; range: string; values: SheetCellInput[][] }
  | { type: 'insert_table'; at: string; headers: string[]; rows: SheetCellValue[][] }
  | { type: 'sort_range'; range: string; by: number; order: 'asc' | 'desc'; hasHeader: boolean }
  | { type: 'format_range'; range: string; bold?: boolean; background?: string; numberFormat?: string };

export type HwpOp =
  | { type: 'append_paragraphs'; paragraphs: string[] }
  | { type: 'replace_text'; find: string; replace: string }
  | { type: 'insert_table'; headers: string[]; rows: string[][] };

export type PdfOp =
  | { type: 'rotate_page'; page: number }
  | { type: 'delete_page'; page: number }
  | { type: 'extract_pages'; from: number; to: number }
  | { type: 'overlay_text'; page: number; text: string; x?: number; y?: number; size?: number };

export interface SheetSnapshotCell {
  v?: SheetCellValue;
  f?: string;
}

export interface SheetSnapshot {
  range?: string;
  cells: Array<Array<SheetSnapshotCell | null | undefined> | undefined>;
}

export interface SheetFinding {
  kind: string;
  cell: string;
  detail: string;
}

const MAX_RANGE_ROWS = 500;
const MAX_RANGE_COLS = 50;
const MAX_RANGE_CELLS = 2500;
const MAX_TEXT = 500;
const MAX_FORMULA = 300;
const ERROR_VALUES = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#NULL!'];

const OPS_BLOCK_GLOBAL = /\[OFFICE_OPS\]([\s\S]*?)\[\/OFFICE_OPS\]/gi;
const OPS_MARKER_RESIDUE = /\[\s*\/?\s*OFFICE_OPS\s*\]/i;

function colToIndex(col: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(col)) return -1;
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseA1Cell(ref: unknown): { row: number; col: number } | null {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(ref || '').trim());
  if (!m) return null;
  const col = colToIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row > 1048575) return null;
  return { row, col };
}

function parseA1Range(
  ref: unknown,
): { start: { row: number; col: number }; end: { row: number; col: number }; rows: number; cols: number } | null {
  const parts = String(ref || '').trim().split(':');
  if (parts.length === 1) {
    const c = parseA1Cell(parts[0]);
    if (!c) return null;
    return { start: c, end: { ...c }, rows: 1, cols: 1 };
  }
  if (parts.length !== 2) return null;
  const a = parseA1Cell(parts[0]);
  const b = parseA1Cell(parts[1]);
  if (!a || !b) return null;
  const start = { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) };
  const end = { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) };
  return { start, end, rows: end.row - start.row + 1, cols: end.col - start.col + 1 };
}

function toA1(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

function isScalar(v: unknown): v is SheetCellValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function normalizeCellInput(v: unknown): SheetCellInput | null {
  if (isScalar(v)) {
    if (typeof v === 'string' && v.startsWith('=')) {
      if (v.length > MAX_FORMULA) return null;
      return { formula: v };
    }
    if (typeof v === 'string' && v.length > MAX_TEXT) return null;
    return { value: v };
  }
  if (v && typeof v === 'object' && typeof (v as { f?: unknown }).f === 'string') {
    const raw = (v as { f: string }).f;
    const f = raw.startsWith('=') ? raw : `=${raw}`;
    if (f.length > MAX_FORMULA) return null;
    return { formula: f };
  }
  return null;
}

function checkRangeSize(r: { rows: number; cols: number }): string | null {
  if (r.rows > MAX_RANGE_ROWS || r.cols > MAX_RANGE_COLS || r.rows * r.cols > MAX_RANGE_CELLS) {
    return `범위가 너무 큽니다 (최대 ${MAX_RANGE_ROWS}행 × ${MAX_RANGE_COLS}열, ${MAX_RANGE_CELLS}셀)`;
  }
  return null;
}

function validateMatrix(raw: unknown): SheetCellInput[][] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RANGE_ROWS) return null;
  let width = -1;
  const out: SheetCellInput[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_RANGE_COLS) return null;
    if (width === -1) width = row.length;
    if (row.length !== width) return null;
    const cells: SheetCellInput[] = [];
    for (const cell of row) {
      const n = normalizeCellInput(cell);
      if (!n) return null;
      cells.push(n);
    }
    out.push(cells);
  }
  if (out.length * width > MAX_RANGE_CELLS) return null;
  return out;
}

/**
 * 연산 목록 검증 공용 루프 (B-L9, 5-7) — validateSheetOps·validateHwpOps·
 * validatePdfOps의 프롤로그(배열 검사·상한 절단·형식 불량 건너뜀)를 공유한다.
 * sheet만 초과 시 오류를 남기므로 warnTooMany로 그 차이를 보존한다
 * (오류 순서는 루프 전 — 원본과 동일).
 */
function validateOpsList<T>(
  raw: unknown,
  validateOne: (o: Record<string, unknown>, ops: T[], errors: string[]) => void,
  opts?: { warnTooMany?: boolean },
): { ops: T[]; errors: string[] } {
  const errors: string[] = [];
  const ops: T[] = [];
  if (!Array.isArray(raw)) return { ops, errors: ['연산 목록이 배열이 아닙니다'] };
  if (opts?.warnTooMany && raw.length > MAX_OPS) errors.push(`연산이 너무 많습니다 (최대 ${MAX_OPS}개)`);
  for (const item of raw.slice(0, MAX_OPS)) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') {
      errors.push('형식이 잘못된 연산을 건너뜀');
      continue;
    }
    validateOne(o, ops, errors);
  }
  return { ops, errors };
}

export function validateSheetOps(raw: unknown): { ops: SheetOp[]; errors: string[] } {
  return validateOpsList<SheetOp>(raw, (o, ops, errors) => {
    switch (o.type) {
      case 'set_cell': {
        const cell = parseA1Cell(o.cell);
        const input = normalizeCellInput(o.formula !== void 0 ? { f: o.formula } : o.value);
        if (!cell) {
          errors.push(`set_cell: 셀 주소가 잘못됨 (${String(o.cell)})`);
          break;
        }
        if (!input) {
          errors.push(`set_cell ${o.cell as string}: 값이 올바르지 않음`);
          break;
        }
        ops.push({ type: 'set_cell', cell: toA1(cell.row, cell.col), ...input });
        break;
      }
      case 'set_range': {
        const range = parseA1Range(o.range);
        if (!range) {
          errors.push(`set_range: 범위가 잘못됨 (${String(o.range)})`);
          break;
        }
        const sizeErr = checkRangeSize(range);
        if (sizeErr) {
          errors.push(`set_range ${o.range as string}: ${sizeErr}`);
          break;
        }
        const values = validateMatrix(o.values);
        if (!values) {
          errors.push(`set_range ${o.range as string}: 값 행렬이 올바르지 않음`);
          break;
        }
        if (values.length !== range.rows || values[0].length !== range.cols) {
          errors.push(`set_range ${o.range as string}: 값 행렬 크기(${values.length}×${values[0].length})가 범위와 다름`);
          break;
        }
        ops.push({ type: 'set_range', range: o.range as string, values });
        break;
      }
      case 'insert_table': {
        const at = parseA1Cell(o.at);
        if (!at) {
          errors.push(`insert_table: 시작 셀이 잘못됨 (${String(o.at)})`);
          break;
        }
        if (
          !Array.isArray(o.headers) ||
          o.headers.length === 0 ||
          o.headers.length > MAX_RANGE_COLS ||
          !o.headers.every((h) => typeof h === 'string' && h.length <= MAX_TEXT)
        ) {
          errors.push('insert_table: 제목행이 올바르지 않음');
          break;
        }
        if (!Array.isArray(o.rows) || o.rows.length > MAX_RANGE_ROWS) {
          errors.push('insert_table: 행이 올바르지 않음');
          break;
        }
        let ok = true;
        const rows: SheetCellValue[][] = [];
        for (const row of o.rows) {
          if (!Array.isArray(row) || row.length !== o.headers.length) {
            ok = false;
            break;
          }
          const cells: SheetCellValue[] = [];
          for (const cell of row) {
            if (!isScalar(cell) || (typeof cell === 'string' && cell.length > MAX_TEXT)) {
              ok = false;
              break;
            }
            cells.push(cell);
          }
          if (!ok) break;
          rows.push(cells);
        }
        if (!ok) {
          errors.push('insert_table: 행 데이터가 올바르지 않음');
          break;
        }
        if ((rows.length + 1) * o.headers.length > MAX_RANGE_CELLS) {
          errors.push('insert_table: 표가 너무 큽니다');
          break;
        }
        ops.push({ type: 'insert_table', at: toA1(at.row, at.col), headers: o.headers as string[], rows });
        break;
      }
      case 'sort_range': {
        const range = parseA1Range(o.range);
        if (!range) {
          errors.push(`sort_range: 범위가 잘못됨 (${String(o.range)})`);
          break;
        }
        const sizeErr = checkRangeSize(range);
        if (sizeErr) {
          errors.push(`sort_range ${o.range as string}: ${sizeErr}`);
          break;
        }
        const by = Number.isInteger(o.by) ? (o.by as number) : 0;
        if (by < 0 || by >= range.cols) {
          errors.push(`sort_range ${o.range as string}: 정렬 열이 범위를 벗어남`);
          break;
        }
        ops.push({
          type: 'sort_range',
          range: o.range as string,
          by,
          order: o.order === 'desc' ? 'desc' : 'asc',
          hasHeader: o.hasHeader === true,
        });
        break;
      }
      case 'format_range': {
        const range = parseA1Range(o.range);
        if (!range) {
          errors.push(`format_range: 범위가 잘못됨 (${String(o.range)})`);
          break;
        }
        const sizeErr = checkRangeSize(range);
        if (sizeErr) {
          errors.push(`format_range ${o.range as string}: ${sizeErr}`);
          break;
        }
        const op: Extract<SheetOp, { type: 'format_range' }> = { type: 'format_range', range: o.range as string };
        if (typeof o.bold === 'boolean') op.bold = o.bold;
        if (typeof o.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.background)) {
          op.background = o.background;
        }
        if (typeof o.numberFormat === 'string' && o.numberFormat.length > 0 && o.numberFormat.length <= 40) {
          op.numberFormat = o.numberFormat;
        }
        if (op.bold === void 0 && !op.background && !op.numberFormat) {
          errors.push(`format_range ${o.range as string}: 적용할 서식이 없음`);
          break;
        }
        ops.push(op);
        break;
      }
      default:
        errors.push(`알 수 없는 연산: ${o.type}`);
    }
  }, { warnTooMany: true });
}

export function inspectSheetSnapshot(snapshot: SheetSnapshot | null | undefined): SheetFinding[] {
  const findings: SheetFinding[] = [];
  if (!snapshot || !Array.isArray(snapshot.cells)) return findings;
  const base = snapshot.range ? parseA1Range(snapshot.range) : null;
  const baseRow = base ? base.start.row : 0;
  const baseCol = base ? base.start.col : 0;
  const cells = snapshot.cells;
  const valueAt = (r: number, c: number): SheetCellValue | undefined => {
    const row = cells[r];
    if (!row) return void 0;
    const cell = row[c];
    return cell ? cell.v : void 0;
  };
  for (let r = 0; r < cells.length; r++) {
    const rowArr = cells[r] || [];
    for (let c = 0; c < rowArr.length; c++) {
      const cell = rowArr[c];
      if (!cell) continue;
      const addr = toA1(baseRow + r, baseCol + c);
      if (typeof cell.v === 'string' && ERROR_VALUES.includes(cell.v)) {
        findings.push({ kind: 'error_value', cell: addr, detail: `오류 값 ${cell.v}` });
      }
      if (typeof cell.f === 'string' && cell.f.includes('#REF!')) {
        findings.push({ kind: 'broken_ref', cell: addr, detail: '수식에 깨진 참조(#REF!)가 있습니다' });
      }
      if (typeof cell.f === 'string') {
        const m = /^=SUM\(([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)\)$/i.exec(cell.f.trim());
        if (m) {
          const c1 = colToIndex(m[1]);
          const c2 = colToIndex(m[3]);
          const r1 = Number(m[2]) - 1;
          const r2 = Number(m[4]) - 1;
          if (c1 >= 0 && (c1 === c2 || r1 === r2)) {
            let sum = 0;
            let seen = 0;
            let inside = true;
            for (let rr = Math.min(r1, r2); rr <= Math.max(r1, r2); rr++) {
              for (let cc = Math.min(c1, c2); cc <= Math.max(c1, c2); cc++) {
                const lr = rr - baseRow;
                const lc = cc - baseCol;
                if (lr < 0 || lc < 0 || lr >= cells.length) {
                  inside = false;
                  break;
                }
                const v = valueAt(lr, lc);
                if (typeof v === 'number' && Number.isFinite(v)) {
                  sum += v;
                  seen++;
                }
              }
              if (!inside) break;
            }
            const own = typeof cell.v === 'number' ? cell.v : NaN;
            if (inside && seen > 0 && Number.isFinite(own)) {
              const tolerance = Math.max(0.01, Math.abs(sum) * 1e-9);
              if (Math.abs(own - sum) > tolerance) {
                findings.push({
                  kind: 'sum_mismatch',
                  cell: addr,
                  detail: `합계 수식 ${cell.f}의 표시값(${own})이 범위 합(${Math.round(sum * 100) / 100})과 다릅니다`,
                });
              }
            }
          }
        }
      }
      if (findings.length >= 50) return findings;
    }
  }
  return findings;
}

export function validateHwpOps(raw: unknown): { ops: HwpOp[]; errors: string[] } {
  return validateOpsList<HwpOp>(raw, (o, ops, errors) => {
    switch (o.type) {
      case 'append_paragraphs': {
        if (
          !Array.isArray(o.paragraphs) ||
          o.paragraphs.length === 0 ||
          o.paragraphs.length > 50 ||
          !o.paragraphs.every((p) => typeof p === 'string' && p.length <= 2e3)
        ) {
          errors.push('append_paragraphs: 문단 목록이 올바르지 않음');
          break;
        }
        ops.push({ type: 'append_paragraphs', paragraphs: o.paragraphs as string[] });
        break;
      }
      case 'replace_text': {
        if (typeof o.find !== 'string' || !o.find || o.find.length > 200 || typeof o.replace !== 'string' || o.replace.length > 2e3) {
          errors.push('replace_text: 찾을/바꿀 문자열이 올바르지 않음');
          break;
        }
        ops.push({ type: 'replace_text', find: o.find, replace: o.replace });
        break;
      }
      case 'insert_table': {
        if (
          !Array.isArray(o.headers) ||
          o.headers.length === 0 ||
          o.headers.length > 8 ||
          !o.headers.every((h) => typeof h === 'string' && h.length <= MAX_TEXT) ||
          !Array.isArray(o.rows) ||
          o.rows.length > 50
        ) {
          errors.push('insert_table: 표가 올바르지 않음');
          break;
        }
        let ok = true;
        for (const row of o.rows) {
          if (!Array.isArray(row) || row.length !== o.headers.length || !row.every((cell) => typeof cell === 'string' && cell.length <= MAX_TEXT)) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          errors.push('insert_table: 행 데이터가 올바르지 않음');
          break;
        }
        ops.push({ type: 'insert_table', headers: o.headers as string[], rows: o.rows as string[][] });
        break;
      }
      default:
        errors.push(`알 수 없는 연산: ${o.type}`);
    }
  });
}

export function validatePdfOps(raw: unknown, pageCount: number): { ops: PdfOp[]; errors: string[] } {
  const page = (v: any): number | null =>
    Number.isInteger(v) && v >= 1 && (pageCount <= 0 || v <= pageCount) ? v : null;
  return validateOpsList<PdfOp>(raw, (o, ops, errors) => {
    switch (o.type) {
      case 'rotate_page': {
        const p = page(o.page);
        if (!p) {
          errors.push('rotate_page: 페이지가 올바르지 않음');
          break;
        }
        ops.push({ type: 'rotate_page', page: p });
        break;
      }
      case 'delete_page': {
        const p = page(o.page);
        if (!p) {
          errors.push('delete_page: 페이지가 올바르지 않음');
          break;
        }
        if (pageCount === 1) {
          errors.push('delete_page: 마지막 페이지는 삭제할 수 없음');
          break;
        }
        ops.push({ type: 'delete_page', page: p });
        break;
      }
      case 'extract_pages': {
        const from = page(o.from);
        const to = page(o.to);
        if (!from || !to || from > to) {
          errors.push('extract_pages: 범위가 올바르지 않음');
          break;
        }
        ops.push({ type: 'extract_pages', from, to });
        break;
      }
      case 'overlay_text': {
        const p = page(o.page);
        if (!p || typeof o.text !== 'string' || !o.text.trim() || o.text.length > 200) {
          errors.push('overlay_text: 페이지/문구가 올바르지 않음');
          break;
        }
        const op: Extract<PdfOp, { type: 'overlay_text' }> = { type: 'overlay_text', page: p, text: o.text };
        if (Number.isFinite(o.x) && (o.x as number) >= 0 && (o.x as number) <= 2e3) op.x = o.x as number;
        if (Number.isFinite(o.y) && (o.y as number) >= 0 && (o.y as number) <= 2e3) op.y = o.y as number;
        if (Number.isFinite(o.size) && (o.size as number) >= 6 && (o.size as number) <= 72) op.size = o.size as number;
        ops.push(op);
        break;
      }
      default:
        errors.push(`알 수 없는 연산: ${o.type}`);
    }
  });
}

export function parseOfficeOpsResponse(text: unknown): {
  reply: string;
  rawOps: any[] | null;
  opsMalformed: boolean;
} {
  const src = String(text || '');
  let rawOps: any[] | null = null;
  let sawBlock = false;
  let reply = src.replace(OPS_BLOCK_GLOBAL, (_m, body) => {
    sawBlock = true;
    if (rawOps === null) {
      try {
        const parsed = JSON.parse(String(body).trim());
        if (parsed && Array.isArray(parsed.ops)) rawOps = parsed.ops;
      } catch {
      }
    }
    return '';
  });
  const residue = OPS_MARKER_RESIDUE.exec(reply);
  if (residue) {
    sawBlock = true;
    if (residue[0].includes('/')) {
      reply = reply.slice(0, residue.index) + reply.slice(residue.index + residue[0].length);
      const again = OPS_MARKER_RESIDUE.exec(reply);
      if (again && !again[0].includes('/')) reply = reply.slice(0, again.index);
    } else {
      reply = reply.slice(0, residue.index);
    }
  }
  return { reply: reply.trim(), rawOps, opsMalformed: sawBlock && rawOps === null };
}

function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signApproval(secret: string, payload: unknown): Promise<string> {
  if (!secret) return '';
  return hmacHex(secret, canonicalJson(payload));
}

export async function verifyApproval(secret: string, payload: unknown, token: string): Promise<boolean> {
  if (!secret || !token) return false;
  const expected = await hmacHex(secret, canonicalJson(payload));
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
