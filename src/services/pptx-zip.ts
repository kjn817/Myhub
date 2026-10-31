// PPTX용 최소 ZIP 작성기 (store 방식, 무압축)
//
// 배경: PPTX는 ZIP + XML 패키지. package.json 런타임 의존성은 hono+zod뿐이고
// wrangler.toml에 nodejs_compat이 없어 Workers 런타임에서 Node zlib/Buffer를
// 쓸 수 없다. 그래서 TextEncoder/Uint8Array/DataView만으로 동작하는 순수
// TypeScript 구현을 둔다. 압축은 하지 않고(store, method 0) 저장하므로
// DEFLATE 구현이 필요 없고, PowerPoint/LibreOffice는 무압축 엔트리도
// 정상적으로 연다. CRC32는 표준 IEEE 테이블 방식으로 계산한다.

export interface ZipEntry {
  /** ZIP 내부 경로 (예: 'ppt/slides/slide1.xml'). 슬래시 구분, UTF-8. */
  path: string
  /** 엔트리 내용 (이미 인코딩된 바이트). */
  data: Uint8Array
}

/** CRC32 (IEEE 802.3, poly 0xEDB88320) 테이블 — 모듈 로드 시 1회 생성. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** 바이트 배열의 CRC32 (unsigned 32-bit). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 현재 시각을 DOS 날짜/시간 필드 값으로 변환한다. */
function dosDateTime(now: Date): { date: number; time: number } {
  const time =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f)
  const date =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f)
  return { date, time }
}

/** UTF-8 문자열을 바이트로 인코딩한다. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * 엔트리들을 store 방식 ZIP 아카이브로 직렬화한다.
 * - Local File Header + 데이터 + Central Directory + End of Central Directory
 * - 파일명 플래그 bit 11(UTF-8) 설정, 외부 속성은 0
 * - 경로 중복이나 빈 경로는 거부한다 (조용히 덮어쓰지 않음).
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error('ZIP 엔트리가 비어 있습니다')
  const seen = new Set<string>()
  for (const e of entries) {
    if (!e.path || e.path.startsWith('/') || e.path.includes('\\')) {
      throw new Error(`잘못된 ZIP 경로: ${e.path}`)
    }
    if (seen.has(e.path)) throw new Error(`중복된 ZIP 경로: ${e.path}`)
    seen.add(e.path)
  }

  const { date, time } = dosDateTime(new Date())
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = utf8(entry.path)
    const crc = crc32(entry.data)
    const size = entry.data.length

    // Local File Header (30 bytes + 파일명)
    const local = new DataView(new ArrayBuffer(30 + name.length))
    local.setUint32(0, 0x04034b50, true) // signature 'PK\x03\x04'
    local.setUint16(4, 20, true) // version needed to extract
    local.setUint16(6, 0x0800, true) // flags: UTF-8 파일명
    local.setUint16(8, 0, true) // method: store
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true) // compressed size (= 원본 크기)
    local.setUint32(22, size, true) // uncompressed size
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true) // extra field length
    new Uint8Array(local.buffer).set(name, 30)
    chunks.push(new Uint8Array(local.buffer), entry.data)

    // Central Directory Header (46 bytes + 파일명)
    const cd = new DataView(new ArrayBuffer(46 + name.length))
    cd.setUint32(0, 0x02014b50, true) // signature 'PK\x01\x02'
    cd.setUint16(4, 20, true) // version made by
    cd.setUint16(6, 20, true) // version needed to extract
    cd.setUint16(8, 0x0800, true) // flags: UTF-8
    cd.setUint16(10, 0, true) // method: store
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size, true)
    cd.setUint32(24, size, true)
    cd.setUint16(28, name.length, true)
    cd.setUint16(30, 0, true) // extra field length
    cd.setUint16(32, 0, true) // comment length
    cd.setUint16(34, 0, true) // disk number start
    cd.setUint16(36, 0, true) // internal attributes
    cd.setUint32(38, 0, true) // external attributes
    cd.setUint32(42, offset, true) // local header offset
    new Uint8Array(cd.buffer).set(name, 46)
    central.push(new Uint8Array(cd.buffer))

    offset += 30 + name.length + size
  }

  const cdOffset = offset
  let cdSize = 0
  for (const c of central) cdSize += c.length

  // End of Central Directory (22 bytes)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true) // signature 'PK\x05\x06'
  eocd.setUint16(4, 0, true) // disk number
  eocd.setUint16(6, 0, true) // central directory disk
  eocd.setUint16(8, entries.length, true) // entries on this disk
  eocd.setUint16(10, entries.length, true) // total entries
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, cdOffset, true)
  eocd.setUint16(20, 0, true) // comment length

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of [...chunks, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  return out
}
