import type { Env } from '../types';
import { getAccessibleMemo } from './ai-access';
import { structureMemoToModel, type OfficeChatFn, type OfficeDocModel } from './office-ai';
import { crc32 } from '../lib/crc32';

export { crc32 } from '../lib/crc32';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 2048, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 2048, true);
    central.setUint16(10, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...chunks, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: EOCD를 찾지 못했습니다');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip: 중앙 디렉터리가 깨졌습니다');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out.set(name, new Uint8Array(raw));
    } else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      out.set(name, new Uint8Array(buf));
    } else {
      throw new Error(`zip: 지원하지 않는 압축 방식 ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref: string, value: string | number | null | undefined): string {
  if (value === null || value === void 0 || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  const s = String(value);
  if (s.startsWith('=') && s.length > 1) {
    return `<c r="${ref}"><f>${xmlEscape(s.slice(1))}</f><v>0</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

export function buildXlsxFromModel(model: OfficeDocModel): Uint8Array {
  const rows: Array<Array<string | number | null>> = [];
  rows.push([model.title]);
  rows.push([]);
  if (model.table) {
    rows.push(model.table.headers);
    for (const row of model.table.rows) rows.push(row);
    rows.push([]);
  }
  for (const p of model.paragraphs) rows.push([p]);
  const sheetRows = rows
    .map((cells, ri) => {
      const cs = cells.map((v, ci) => cellXml(`${colName(ci)}${ri + 1}`, v)).join('');
      return `<row r="${ri + 1}">${cs}</row>`;
    })
    .join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(model.title.slice(0, 31) || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const enc = new TextEncoder();
  return buildStoredZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);
}

function hwpxParagraph(id: number, text: string): string {
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run></hp:p>`;
}

export async function buildHwpxFromModel(templateBytes: Uint8Array, model: OfficeDocModel): Promise<Uint8Array> {
  const entries = await readZipEntries(templateBytes);
  const section = entries.get('Contents/section0.xml');
  if (!section) throw new Error('hwpx: 템플릿에 section0.xml이 없습니다');
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let xml = dec.decode(section);
  const lines = [model.title, ...model.paragraphs];
  if (model.table) {
    lines.push(model.table.headers.map((h) => String(h)).join(' | '));
    for (const row of model.table.rows) lines.push(row.map((c) => String(c ?? '')).join(' | '));
  }
  const [first, ...rest] = lines;
  if (!xml.includes('<hp:t/>')) throw new Error('hwpx: 템플릿 첫 문단 구조가 다릅니다');
  xml = xml.replace('<hp:t/>', `<hp:t>${xmlEscape(first ?? '')}</hp:t>`);
  if (rest.length) {
    const extra = rest.map((text, i) => hwpxParagraph(1e3 + i, text)).join('');
    xml = xml.replace('</hs:sec>', `${extra}</hs:sec>`);
  }
  entries.set('Contents/section0.xml', enc.encode(xml));
  const ordered: ZipEntry[] = [];
  const names = [...entries.keys()].sort(
    (a, b) => (a === 'mimetype' ? -1 : b === 'mimetype' ? 1 : 0)
  );
  for (const name of names) ordered.push({ name, data: entries.get(name) as Uint8Array });
  return buildStoredZip(ordered);
}

async function defaultLoadTemplate(env: Env): Promise<Uint8Array> {
  if (env?.ASSETS?.fetch) {
    const res = await env.ASSETS.fetch('https://assets.local/templates/blank.hwpx');
    if (res && res.ok) return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error('template_unavailable');
}

async function defaultSaveFile(env: Env, bytes: Uint8Array, filename: string, mime: string): Promise<{ id: number }> {
  const { storageUpload } = await import('./storage');
  const file = new File([bytes], filename, { type: mime });
  const up = await storageUpload(env, file, 'myhub/drive');
  const r = await env.DB.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (NULL, ?, ?, ?, ?, ?, ?)',
  )
    .bind(up.public_id, filename, mime, up.bytes, up.secure_url, up.resource_type)
    .run();
  return { id: Number(r.meta.last_row_id) };
}

export interface GenerateDocDeps {
  chat?: OfficeChatFn;
  loadTemplate?: (env: Env) => Promise<Uint8Array>;
  saveFile?: (env: Env, bytes: Uint8Array, filename: string, mime: string) => Promise<{ id: number }>;
}

export async function generateDocFromMemo(
  env: Env,
  input: { memoId: number; target: 'excel' | 'hangul'; dateLabel?: string },
  deps: GenerateDocDeps = {},
): Promise<{ fileId: number; filename: string; title: string; target: 'excel' | 'hangul' }> {
  const memo = await getAccessibleMemo(env, input.memoId);
  if (!memo) throw new Error('memo_not_found');
  const model = await structureMemoToModel(env, memo.content, input.target, deps.chat);
  const dateLabel = input.dateLabel || new Date().toISOString().slice(0, 10);
  if (input.target === 'excel') {
    const bytes = buildXlsxFromModel(model);
    const filename = `${model.title} ${dateLabel}.xlsx`;
    const saved = await (deps.saveFile || defaultSaveFile)(
      env,
      bytes,
      filename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    return { fileId: saved.id, filename, title: model.title, target: 'excel' };
  }
  const template = await (deps.loadTemplate || defaultLoadTemplate)(env);
  const bytes = await buildHwpxFromModel(template, model);
  const filename = `${model.title} ${dateLabel}.hwpx`;
  const saved = await (deps.saveFile || defaultSaveFile)(env, bytes, filename, 'application/hwp+zip');
  return { fileId: saved.id, filename, title: model.title, target: 'hangul' };
}
