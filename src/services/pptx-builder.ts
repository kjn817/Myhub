// 최소 PPTX 생성기 — 네이티브 PowerPoint 덱 (네이티브 도형 + 네이티브 차트)
//
// ppt-master 패턴(문서·주제 → 네이티브 덱)을 Workers 안에서 재현한 최소 구현.
// Python 서비스라 Workers에 직접 올릴 수 없으므로, PPTX가 ZIP+XML이라는
// 점에 착안해 순수 TypeScript로 패키지를 직접 조립한다 (의존성 0개).
// - 슬라이드: 빈 레이아웃 + 절대 위치 네이티브 도형(p:sp)
// - 차트: 네이티브 막대 차트(c:barChart, 값 캐시 내장 — 외부 엑셀 불필요)
// - 전환: 전 슬라이드 fade 전환(p:transition)
// - 한글: 동아시아 폰트 Malgun Gothic 지정, UTF-8 인코딩
//
// 참고: 슬라이드 크기 13.33x7.5in (12192000 x 6858000 EMU).

import { createZip, utf8, type ZipEntry } from './pptx-zip'

export interface PptxTitleSlide {
  kind: 'title'
  title: string
  subtitle?: string
  meta?: string
}

export interface PptxBulletSlide {
  kind: 'bullets'
  title: string
  bullets: string[]
  /** 항목이 없을 때 표시할 문구 (기본값: '항목이 없습니다'). */
  emptyText?: string
}

export interface PptxChartSlide {
  kind: 'chart'
  title: string
  /** X축 카테고리 (예: ['월', '화', '수']). */
  categories: string[]
  /** 계열 — 1개 이상. values 길이는 categories와 같아야 한다. */
  series: { name: string; values: number[] }[]
}

export type PptxSlide = PptxTitleSlide | PptxBulletSlide | PptxChartSlide

export interface PptxDeck {
  /** 프레젠테이션 제목 (core properties 아님 — 표지 슬라이드 제목과 별개). */
  title: string
  slides: PptxSlide[]
}

// ---- 색상 (MyHub 디자인: 흰/회/검 + 파스텔 블루) ----
const INK = '1F2937' // 본문 검정
const MUTED = '6B7280' // 보조 회색
const ACCENT = '5B9BD5' // 파스텔 블루
const ACCENT_LIGHT = 'DCE8F5'
const WHITE = 'FFFFFF'

const EMU_W = 12192000
const EMU_H = 6858000

/** XML 특수문자 이스케이프. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 개행·제어문자를 제거하고 앞뒤 공백을 정리한다 (슬라이드 텍스트용). */
function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim()
}

interface RunOpts {
  sizePt: number
  bold?: boolean
  color?: string
  italic?: boolean
}

/** 텍스트 단락 1개 (a:p). bullet이면 글머리 기호를 단다. */
function paragraph(text: string, opts: RunOpts & { bullet?: boolean; align?: string; spaceBeforePt?: number }): string {
  const size = Math.round(opts.sizePt * 100)
  const rPr =
    `<a:rPr lang="ko-KR" sz="${size}" b="${opts.bold ? 1 : 0}" i="${opts.italic ? 1 : 0}">` +
    `<a:solidFill><a:srgbClr val="${opts.color ?? INK}"/></a:solidFill>` +
    `<a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/></a:rPr>`
  const pPrAttrs = [
    opts.align ? `algn="${opts.align}"` : '',
    opts.spaceBeforePt ? `spcBef="${Math.round(opts.spaceBeforePt * 100)}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const bullet = opts.bullet
    ? `<a:buFont typeface="Arial"/><a:buChar char="•"/>`
    : `<a:buNone/>`
  return (
    `<a:p><a:pPr marL="228600" indent="-228600" ${pPrAttrs}>${bullet}</a:pPr>` +
    `<a:r>${rPr}<a:t>${escapeXml(cleanText(text))}</a:t></a:r></a:p>`
  )
}

/** 절대 위치 텍스트 도형 (p:sp). paragraphs는 이미 조립된 a:p 문자열 배열. */
function textShape(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvSpPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`
  )
}

/** 단색 채움 사각형 도형 (배경·구분선용). */
function rectShape(id: number, name: string, x: number, y: number, cx: number, cy: number, fill: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvSpPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/></p:txBody></p:sp>`
  )
}

/** 슬라이드 공통 래퍼 (그룹 도형 + 전환 포함). */
function slideXml(shapes: string[]): string {
  return (
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr>` +
    shapes.join('') +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `<p:transition spd="med"><p:fade thruBlk="1"/></p:transition>` +
    `</p:sld>`
  )
}

/** 표지 슬라이드. */
function titleSlideXml(s: PptxTitleSlide): string {
  const shapes: string[] = [
    rectShape(2, '배경', 0, 0, EMU_W, EMU_H, WHITE),
    rectShape(3, '상단바', 0, 0, EMU_W, 182880, ACCENT),
    rectShape(4, '하단바', 0, EMU_H - 182880, EMU_W, 182880, ACCENT_LIGHT),
    textShape(5, '제목', 914400, 2286000, 10363200, 1600200, [
      paragraph(s.title, { sizePt: 44, bold: true, color: INK }),
    ]),
  ]
  if (s.subtitle) {
    shapes.push(
      textShape(6, '부제목', 914400, 4114800, 10363200, 914400, [
        paragraph(s.subtitle, { sizePt: 22, color: MUTED }),
      ]),
    )
  }
  if (s.meta) {
    shapes.push(
      textShape(7, '메타', 914400, 5029200, 10363200, 457200, [
        paragraph(s.meta, { sizePt: 16, color: MUTED }),
      ]),
    )
  }
  return slideXml(shapes)
}

/** 목록 슬라이드. */
function bulletsSlideXml(s: PptxBulletSlide): string {
  const items = s.bullets.length > 0 ? s.bullets : [s.emptyText ?? '항목이 없습니다']
  const paras = items.map((b, i) =>
    paragraph(b, { sizePt: 20, color: INK, bullet: s.bullets.length > 0, spaceBeforePt: i === 0 ? 0 : 12 }),
  )
  return slideXml([
    rectShape(2, '배경', 0, 0, EMU_W, EMU_H, WHITE),
    rectShape(3, '상단바', 0, 0, EMU_W, 91440, ACCENT),
    textShape(4, '제목', 914400, 457200, 10363200, 914400, [
      paragraph(s.title, { sizePt: 30, bold: true, color: INK }),
    ]),
    textShape(5, '목록', 914400, 1600200, 10363200, 4572000, paras),
  ])
}

/** 차트 슬라이드 (네이티브 막대 차트 포함). chartRId는 슬라이드 rels의 차트 관계 ID. */
function chartSlideXml(s: PptxChartSlide, chartRId: string): string {
  const frame =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="차트"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="914400" y="1600200"/><a:ext cx="10363200" cy="4572000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${chartRId}"/>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  return slideXml([
    rectShape(2, '배경', 0, 0, EMU_W, EMU_H, WHITE),
    rectShape(3, '상단바', 0, 0, EMU_W, 91440, ACCENT),
    textShape(4, '제목', 914400, 457200, 10363200, 914400, [
      paragraph(s.title, { sizePt: 30, bold: true, color: INK }),
    ]),
    textShape(5, '설명', 914400, 1371600, 10363200, 228600, [
      paragraph(s.series.map((x) => x.name).join(' · '), { sizePt: 14, color: MUTED }),
    ]),
    frame,
  ])
}

/** 카테고리/값 캐시를 문자열·숫자 참조로 직렬화한다 (외부 워크북 없이 캐시만 사용). */
function strCache(values: string[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`
}

function numCache(values: number[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`
}

/** 네이티브 막대 차트 파트 (c:chartSpace). */
function chartXml(s: PptxChartSlide): string {
  if (s.categories.length === 0) throw new Error('차트 카테고리가 비어 있습니다')
  for (const ser of s.series) {
    if (ser.values.length !== s.categories.length) {
      throw new Error(`차트 계열 "${ser.name}"의 값 개수(${ser.values.length})가 카테고리 개수(${s.categories.length})와 다릅니다`)
    }
  }
  const colors = [ACCENT, 'ED7D31', '70AD47', 'FFC000', '7030A0']
  const seriesXml = s.series
    .map((ser, idx) => {
      const col = colors[idx % colors.length]
      return (
        `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>` +
        `<c:tx><c:strRef><c:f>Sheet1!$${String.fromCharCode(66 + idx)}$1</c:f>${strCache([ser.name])}</c:strRef></c:tx>` +
        `<c:spPr><a:solidFill><a:srgbClr val="${col}"/></a:solidFill></c:spPr>` +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${s.categories.length + 1}</c:f>${strCache(s.categories)}</c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$${String.fromCharCode(66 + idx)}$2:$${String.fromCharCode(66 + idx)}$${s.categories.length + 1}</c:f>${numCache(ser.values)}</c:numRef></c:val>` +
        `</c:ser>`
      )
    })
    .join('')
  return (
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>` +
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
    `${seriesXml}` +
    `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls>` +
    `<c:gapWidth val="150"/><c:overlap val="0"/><c:axId val="1"/><c:axId val="2"/>` +
    `</c:barChart>` +
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx>` +
    `</c:plotArea><c:plotVisOnly val="1"/></c:chart>` +
    `</c:chartSpace>`
  )
}

// ---- 패키지 공통 파트 ----

function contentTypesXml(slideCount: number, chartCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('')
  const chartOverrides = Array.from({ length: chartCount }, (_, i) =>
    `<Override PartName="/ppt/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
  ).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `${slideOverrides}${chartOverrides}</Types>`
  )
}

function packageRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
    `</Relationships>`
  )
}

function presentationXml(slideCount: number): string {
  const sldIds = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${3 + i}"/>`).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${EMU_W}" cy="${EMU_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  )
}

function presentationRelsXml(slideCount: number): string {
  const slideRels = Array.from({ length: slideCount }, (_, i) =>
    `<Relationship Id="rId${3 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
    `${slideRels}</Relationships>`
  )
}

function slideMasterXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${WHITE}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200"><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:lvl1pPr></p:bodyStyle>` +
    `<p:otherStyle><a:defPPr><a:defRPr sz="1800"><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:defPPr></p:otherStyle></p:txStyles>` +
    `</p:sldMaster>`
  )
}

function slideMasterRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
    `</Relationships>`
  )
}

function slideLayoutXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" showMasterSp="0">` +
    `<p:cSld name="빈 화면"><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  )
}

function slideLayoutRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    `</Relationships>`
  )
}

function slideRelsXml(hasChart: boolean, chartNo = 1): string {
  const chartRel = hasChart
    ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNo}.xml"/>`
    : ''
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `${chartRel}</Relationships>`
  )
}

function themeXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MyHub">` +
    `<a:themeElements><a:clrScheme name="MyHub">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="${INK}"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${ACCENT}"/></a:accent1>` +
    `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="70AD47"/></a:accent3>` +
    `<a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="7030A0"/></a:accent5>` +
    `<a:accent6><a:srgbClr val="4472C4"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="MyHub">` +
    `<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface="Calibri"/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Malgun Gothic"/><a:cs typeface="Calibri"/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="MyHub">` +
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
    `</a:fmtScheme></a:themeElements></a:theme>`
  )
}

/**
 * 덱을 PPTX 바이트(Uint8Array)로 조립한다.
 * 슬라이드가 0개면 거부한다. 차트 슬라이드가 여러 개면 차트 파트는
 * chart1..chartN으로 번호를 매긴다 (슬라이드 rels는 각자 자신의 차트를 가리킴).
 */
export function buildPptx(deck: PptxDeck): Uint8Array {
  if (deck.slides.length === 0) throw new Error('슬라이드가 비어 있습니다')
  const chartSlides = deck.slides.filter((s): s is PptxChartSlide => s.kind === 'chart')
  const chartIndexBySlide = new Map<number, number>()
  deck.slides.forEach((s, i) => {
    if (s.kind === 'chart') chartIndexBySlide.set(i, chartIndexBySlide.size + 1)
  })

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: utf8(contentTypesXml(deck.slides.length, chartSlides.length)) },
    { path: '_rels/.rels', data: utf8(packageRelsXml()) },
    { path: 'ppt/presentation.xml', data: utf8(presentationXml(deck.slides.length)) },
    { path: 'ppt/_rels/presentation.xml.rels', data: utf8(presentationRelsXml(deck.slides.length)) },
    { path: 'ppt/slideMasters/slideMaster1.xml', data: utf8(slideMasterXml()) },
    { path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: utf8(slideMasterRelsXml()) },
    { path: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(slideLayoutXml()) },
    { path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: utf8(slideLayoutRelsXml()) },
    { path: 'ppt/theme/theme1.xml', data: utf8(themeXml()) },
  ]

  deck.slides.forEach((slide, i) => {
    const n = i + 1
    let xml: string
    let chartNo = 0
    if (slide.kind === 'title') {
      xml = titleSlideXml(slide)
    } else if (slide.kind === 'bullets') {
      xml = bulletsSlideXml(slide)
    } else {
      chartNo = chartIndexBySlide.get(i) ?? 1
      xml = chartSlideXml(slide, 'rId2')
      entries.push({
        path: `ppt/charts/chart${chartNo}.xml`,
        data: utf8(chartXml(slide)),
      })
    }
    entries.push({ path: `ppt/slides/slide${n}.xml`, data: utf8(xml) })
    entries.push({ path: `ppt/slides/_rels/slide${n}.xml.rels`, data: utf8(slideRelsXml(chartNo > 0, chartNo)) })
  })

  return createZip(entries)
}
