/// <reference types="jest" />
/**
 * 앱 아이콘 회귀 테스트 (2026-11-16, 사용자 요청: Muse처럼 둥글게).
 *
 * 배경: 기존 icon-512.png는 RGB 정사각형(흰 네모에 JN)에 불과해 윈도우
 * 바탕화면에서 어설퍼 보였다. 새 아이콘은 투명 모서리의 둥근 스쿼클
 * (그라데이션 + 네이비 JN)이며, 마스커블·애플 터치용 전체 채움본도 있다.
 * 생성기: scripts/build-app-icon.py
 *
 * 이 테스트가 검증하는 성질:
 * - icon-512/192가 RGBA(색상 타입 6)이고 512×512·192×192 크기다.
 * - 네 모서리 픽셀의 알파가 0이다 (둥근 모서리 — 네모 흰 판 회귀 방지).
 * - 마스커블·애플 터치 아이콘은 불투명 RGB이고 manifest·에셋 목록에 있다.
 * - manifest가 3종 아이콘(192·512·마스커블)을 올바른 purpose로 싣는다.
 *
 * 카나리아: icon-512.png를 RGB로 바꾸거나 모서리를 채우면 실패한다.
 * PNG 파싱은 IHDR + IDAT inflate(내장 zlib)만으로 하며, 첫 행 첫 픽셀은
 * 필터 종류와 무관하게 raw 값 그대로다 (좌·상 이웃이 없어 보정 항이 0).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function readPng(file: string): { width: number; height: number; colorType: number; idat: Buffer } {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${file} is not a PNG`);
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatParts: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      colorType = buf[off + 17];
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(off + 8, off + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  return { width, height, colorType, idat: Buffer.concat(idatParts) };
}

function cornerAlphas(file: string): { tl: number; tr: number; bl: number; br: number } {
  const { width, height, colorType, idat } = readPng(file);
  if (colorType !== 6) throw new Error(`${file} is not RGBA`);
  const raw = zlib.inflateSync(idat);
  const stride = 1 + width * 4;
  // 첫 행 첫 픽셀은 필터와 무관하게 raw 값 그대로다.
  const tl = raw[1 + 3];
  // 첫 행 마지막 픽셀: 필터 보정이 필요하므로 행 전체를 복원한다.
  const restoreRow = (row: number): Buffer => {
    const start = row * stride;
    const filter = raw[start];
    const rowBuf = Buffer.from(raw.subarray(start + 1, start + stride));
    const prev = row === 0 ? Buffer.alloc(width * 4, 0) : restoreRow(row - 1);
    const bpp = 4;
    for (let i = 0; i < rowBuf.length; i++) {
      const a = i >= bpp ? rowBuf[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rowBuf[i] = (rowBuf[i] + pred) & 0xff;
    }
    return rowBuf;
  };
  const firstRow = restoreRow(0);
  const lastRow = restoreRow(height - 1);
  const tr = firstRow[(width - 1) * 4 + 3];
  const bl = lastRow[3];
  const br = lastRow[(width - 1) * 4 + 3];
  return { tl, tr, bl, br };
}

describe('앱 아이콘 (둥근 스쿼클)', () => {
  test('icon-512.png는 512×512 RGBA이고 네 모서리가 투명하다', () => {
    const { width, height, colorType } = readPng(path.join(PUBLIC, 'icon-512.png'));
    expect(width).toBe(512);
    expect(height).toBe(512);
    expect(colorType).toBe(6);
    const c = cornerAlphas(path.join(PUBLIC, 'icon-512.png'));
    expect(c).toEqual({ tl: 0, tr: 0, bl: 0, br: 0 });
  });

  test('icon-192.png는 192×192 RGBA이고 네 모서리가 투명하다', () => {
    const { width, height, colorType } = readPng(path.join(PUBLIC, 'icon-192.png'));
    expect(width).toBe(192);
    expect(height).toBe(192);
    expect(colorType).toBe(6);
    const c = cornerAlphas(path.join(PUBLIC, 'icon-192.png'));
    expect(c).toEqual({ tl: 0, tr: 0, bl: 0, br: 0 });
  });

  test('마스커블·애플 터치 아이콘은 불투명 RGB이다', () => {
    for (const [file, size] of [['icon-512-maskable.png', 512], ['apple-touch-icon.png', 180]] as const) {
      const { width, height, colorType } = readPng(path.join(PUBLIC, file));
      expect(width).toBe(size);
      expect(height).toBe(size);
      expect(colorType).toBe(2);
    }
  });

  test('manifest가 192·512·마스커블 3종을 싣는다', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf-8'));
    const icons = manifest.icons as Array<{ sizes: string; src: string; purpose?: string }>;
    expect(icons).toContainEqual({ sizes: '192x192', src: '/icon-192.png', type: 'image/png' });
    expect(icons).toContainEqual({ sizes: '512x512', src: '/icon-512.png', type: 'image/png' });
    expect(icons).toContainEqual({ sizes: '512x512', src: '/icon-512-maskable.png', type: 'image/png', purpose: 'maskable' });
  });

  test('static-assets.json이 마스커블 아이콘을 포함한다', () => {
    const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/static-assets.json'), 'utf-8'));
    expect(assets.files).toContain('/icon-512-maskable.png');
    expect(assets.files).toContain('/icon-512.png');
    expect(assets.files).toContain('/icon-192.png');
  });
});
