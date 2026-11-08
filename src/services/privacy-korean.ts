import { buildDetectionView, viewSpanToOriginal, originalSpanToView } from './privacy-detection-view';

export type KoreanCandidateType = 'NAME' | 'ADDRESS' | 'RELATION';

export interface KoreanCandidate {
  type: KoreanCandidateType;
  start: number;
  end: number;
  cue: string;
}

export interface ScoredKoreanCandidate extends KoreanCandidate {
  score: number;
}

export interface KoreanFinding {
  type: string;
  level: number;
  start: number;
  end: number;
  source: 'context';
  score: number;
}

export type KoreanAction = 'tokenize' | 'gray' | 'pass';

const SURNAMES = [
  "\uAE40",
  "\uC774",
  "\uBC15",
  "\uCD5C",
  "\uC815",
  "\uAC15",
  "\uC870",
  "\uC724",
  "\uC7A5",
  "\uC784",
  "\uD55C",
  "\uC624",
  "\uC11C",
  "\uC2E0",
  "\uAD8C",
  "\uD669",
  "\uC548",
  "\uC1A1",
  "\uC591",
  "\uC190",
  "\uBC30",
  "\uC870",
  "\uBC31",
  "\uD5C8",
  "\uC720",
  "\uB0A8",
  "\uC2EC",
  "\uB178",
  "\uD558",
  "\uACFD",
  "\uC131",
  "\uCC28",
  "\uC8FC",
  "\uC6B0",
  "\uAD6C",
  "\uBBFC",
  "\uC9C4",
  "\uC9C0",
  "\uC5C4",
  "\uCC44",
  "\uC6D0",
  "\uCC9C",
  "\uBC29",
  "\uACF5",
  "\uD604",
  "\uD568",
  "\uBCC0",
  "\uC5FC",
  "\uC5EC",
  "\uCD94",
  "\uB3C4",
  "\uB958",
  "\uC18C",
  "\uC11D",
  "\uC120",
  "\uC124",
  "\uB9C8",
  "\uAE38",
  "\uC5F0",
  "\uC704",
  "\uD45C",
  "\uBA85",
  "\uAE30",
  "\uBC18",
  "\uC655",
  "\uAE08",
  "\uC625",
  "\uC721",
  "\uC778",
  "\uB9F9",
  "\uC81C",
  "\uBAA8",
  "\uD0C1",
  "\uAD6D",
  "\uC5B4",
  "\uC740",
  "\uD3B8",
  "\uC608",
  "\uBD09",
  "\uD64D",
  "\uC804",
  "\uACE0",
  "\uBB38",
  "\uC190",
  "\uC591",
  "\uBC30",
  // 복성
  "\uB0A8\uAD81",
  "\uD669\uBCF4",
  "\uC120\uC6B0",
  "\uB3C5\uACE0",
  "\uC81C\uAC08",
  "\uC0AC\uACF5",
  "\uC11C\uBB38",
  "\uB3D9\uBC29"
];
const SURNAME_SET = new Set(SURNAMES);
const COMPOUND_SURNAMES = SURNAMES.filter((s) => s.length === 2);
const HOMOGRAPH_WORDS = new Set([
  "\uD558\uB298",
  "\uBC14\uB2E4",
  "\uAC00\uC744",
  "\uACA8\uC6B8",
  "\uBD04",
  "\uC5EC\uB984",
  "\uAD6C\uB984",
  "\uBCC4",
  "\uB2EC",
  "\uD574",
  "\uC0B0",
  "\uAC15",
  "\uAF43",
  "\uC78E",
  "\uBC25",
  "\uCE58",
  "\uAD6D",
  "\uD0D5",
  "\uBA74",
  "\uB5A1",
  "\uC9D1",
  "\uCC28",
  "\uB9D0",
  "\uAE00",
  "\uC190",
  "\uBC1C",
  "\uB208",
  "\uCF54",
  "\uC785",
  "\uD574\uC218",
  "\uCE58\uD0A8",
  "\uBC25\uC0C1",
  "\uCE58\uC988",
  "\uAD6D\uC218",
  "\uD574\uC7A5",
  "\uAD6D\uBC25"
]);
const NON_NAME_COMPOUNDS = [
  "\uAE40\uBC25",
  "\uAE40\uCE58",
  "\uAE40\uD574",
  "\uAE40\uD3EC",
  "\uAE40\uC81C",
  "\uAE40\uCC9C",
  "\uC774\uCC9C",
  "\uC774\uCC9C\uC218",
  "\uBC15\uBB3C\uAD00",
  "\uCD5C\uACE0",
  "\uC815\uB9D0",
  "\uC815\uBCF4",
  "\uAC15\uB0A8",
  "\uAC15\uB989",
  "\uAC15\uC6D0",
  "\uAC15\uD654",
  "\uC8FC\uCC28",
  "\uC8FC\uC7A5",
  "\uD589\uC815",
  "\uC815\uC0C1",
  "\uC131\uC7A5",
  "\uC2DC\uC7A5",
  "\uACFC\uC7A5\uB2D8\uC740",
  // 성씨 음절로 시작하는 시설·장소 일반명사 (예: 연+구실) — 사람 이름이 아니다
  "\uC5F0\uAD6C\uC2E4",
  "\uC5F0\uC2B5\uC2E4",
  "\uC5F0\uD68C\uC7A5",
  "\uC5F0\uB77D\uCC98"
];
const COMMON_WORD_SPANS = new Set(["\uC6B0\uB9AC", "\uC800\uD76C", "\uB108\uD76C", "\uADF8\uB300", "\uC544\uBB34", "\uBAA8\uB450"]);
const TITLES = ["\uB300\uD45C\uC774\uC0AC", "\uB300\uD45C", "\uC6D0\uC7A5", "\uAD50\uC218", "\uD300\uC7A5", "\uACFC\uC7A5", "\uCC28\uC7A5", "\uBD80\uC7A5", "\uB300\uB9AC", "\uC8FC\uC784", "\uC0AC\uC6D0", "\uC120\uC0DD\uB2D8", "\uC120\uC0DD", "\uBC15\uC0AC", "\uC774\uC0AC", "\uC0C1\uBB34", "\uC804\uBB34", "\uC0AC\uC7A5", "\uC2E4\uC7A5", "\uC13C\uD130\uC7A5", "\uC18C\uC7A5", "\uAD6D\uC7A5", "\uCC98\uC7A5", "\uBCF8\uBD80\uC7A5", "\uC9C0\uC810\uC7A5", "\uB9E4\uB2C8\uC800", "PM", "\uC8FC\uBB34\uAD00"];
const TITLES_BY_LENGTH = [...TITLES].sort((a, b) => b.length - a.length);
const HONORIFICS = ["\uB2D8", "\uC528"];
const NAME_LABELS = ["\uB2F4\uB2F9\uC790", "\uC218\uB839\uC778", "\uC131\uBA85", "\uC131\uD568", "\uC774\uB984", "\uC5F0\uB77D\uCC98", "\uC608\uC57D\uC790", "\uC2E0\uCCAD\uC778", "\uBCF4\uD638\uC790", "\uC218\uC2E0\uC778", "\uBC1C\uC2E0\uC778", "\uC791\uC131\uC790", "\uACB0\uC7AC\uC790", "\uC2B9\uC778\uC790", "\uD658\uC790", "\uACE0\uAC1D", "\uD68C\uC6D0", "\uD559\uC0DD", "\uAD50\uC0AC", "\uC800\uC790", "\uBC88\uC5ED\uC790"];
const PARTICLES = ["\uC740", "\uB294", "\uC774", "\uAC00", "\uC744", "\uB97C", "\uC5D0\uAC8C", "\uD55C\uD14C", "\uAED8", "\uC758", "\uC640", "\uACFC", "\uB3C4", "\uB9CC", "\uBD80\uD130", "\uAE4C\uC9C0", "\uB791", "\uC774\uB791", "\uBCF4\uB2E4", "\uCC98\uB7FC", "\uAED8\uC11C", "\uC5D0\uC11C"];
const RELATION_WORDS = ["\uC544\uB0B4", "\uB0A8\uD3B8", "\uBC30\uC6B0\uC790", "\uBD80\uC778", "\uC5B4\uBA38\uB2C8", "\uC544\uBC84\uC9C0", "\uBD80\uBAA8\uB2D8", "\uC790\uB140", "\uC544\uB4E4", "\uB538", "\uAC00\uC871", "\uC0C1\uC0AC", "\uB3D9\uB8CC", "\uC120\uBC30", "\uD6C4\uBC30", "\uD300\uC6D0"];
const ADDRESS_LABELS = ["\uC8FC\uC18C", "\uBC30\uC1A1\uC9C0", "\uC790\uD0DD", "\uAC70\uC8FC\uC9C0", "\uD604\uC7A5 \uC8FC\uC18C", "\uADC0\uAC00 \uC8FC\uC18C", "\uC774\uC0AC \uAC08 \uC9D1", "\uBC30\uC1A1 \uC8FC\uC18C", "\uBC1B\uB294 \uC8FC\uC18C"];
const SIDO = ["\uC11C\uC6B8\uD2B9\uBCC4\uC2DC", "\uBD80\uC0B0\uAD11\uC5ED\uC2DC", "\uB300\uAD6C\uAD11\uC5ED\uC2DC", "\uC778\uCC9C\uAD11\uC5ED\uC2DC", "\uAD11\uC8FC\uAD11\uC5ED\uC2DC", "\uB300\uC804\uAD11\uC5ED\uC2DC", "\uC6B8\uC0B0\uAD11\uC5ED\uC2DC", "\uC138\uC885\uD2B9\uBCC4\uC790\uCE58\uC2DC", "\uACBD\uAE30\uB3C4", "\uAC15\uC6D0\uD2B9\uBCC4\uC790\uCE58\uB3C4", "\uAC15\uC6D0\uB3C4", "\uCDA9\uCCAD\uBD81\uB3C4", "\uCDA9\uCCAD\uB0A8\uB3C4", "\uC804\uBD81\uD2B9\uBCC4\uC790\uCE58\uB3C4", "\uC804\uB77C\uBD81\uB3C4", "\uC804\uB77C\uB0A8\uB3C4", "\uACBD\uC0C1\uBD81\uB3C4", "\uACBD\uC0C1\uB0A8\uB3C4", "\uC81C\uC8FC\uD2B9\uBCC4\uC790\uCE58\uB3C4", "\uC11C\uC6B8", "\uBD80\uC0B0", "\uB300\uAD6C", "\uC778\uCC9C", "\uAD11\uC8FC", "\uB300\uC804", "\uC6B8\uC0B0", "\uC138\uC885"];
const ROAD_RE = /[가-힣]{1,10}(?:대로|로\d{1,3}번길|로|길)\s*\d{1,4}(?:-\d{1,4})?/g;
const JIBUN_RE = /[가-힣]{1,6}(?:동|읍|면|리)\s*\d{1,4}(?:-\d{1,4})?(?:번지)?/g;
const MAX_CANDIDATES = 8;
const ACTION_STEMS = ["\uACB0\uC7AC", "\uC2B9\uC778", "\uCC98\uB9AC", "\uBCF4\uACE0", "\uD655\uC778", "\uC804\uB2EC", "\uAC80\uD1A0", "\uC11C\uBA85"];
const ACTION_RE = new RegExp(
  `(?:${ACTION_STEMS.join("|")})(?:\uC744|\uB97C)?\\s*(?:\uD558\uACE0|\uD558\uC5EC|\uD574\uC11C|\uC644\uB8CC|\uC9C4\uD589|\uC694\uCCAD|\uBD80\uD0C1|\uBC1B|\uD574|\uD558|\uD588|\uD569|\uB4DC|\uC8FC)`
);
const THRESHOLDS: Record<KoreanCandidateType, { tokenize: number; gray: number }> = {
  NAME: { tokenize: 0.8, gray: 0.6 },
  ADDRESS: { tokenize: 0.75, gray: 0.55 },
  RELATION: { tokenize: 0.85, gray: 0.7 }
};

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

function nameCandidates(text: string): KoreanCandidate[] {
  const out: KoreanCandidate[] = [];
  for (let i = 0; i < text.length; i++) {
    let surname: string | null = null;
    for (const cs of COMPOUND_SURNAMES) {
      if (text.startsWith(cs, i)) {
        surname = cs;
        break;
      }
    }
    if (!surname && SURNAME_SET.has(text[i])) surname = text[i];
    if (!surname) continue;
    if (i > 0 && /[가-힣]/.test(text[i - 1])) continue;
    const rest = text.slice(i + surname.length);
    if (NON_NAME_COMPOUNDS.some((w) => text.startsWith(w, i) && surname !== null && w.startsWith(surname))) {
    }
    for (let len = 3; len >= 1; len--) {
      const given = rest.slice(0, len);
      if (given.length < len || !/^[가-힣]+$/.test(given)) continue;
      const after = rest.slice(len);
      if (len >= 2 && PARTICLES.includes(given[given.length - 1]) && !PARTICLES.some((p) => after.startsWith(p)) && !TITLES.some((t) => after.replace(/^\s+/, '').startsWith(t)) && !HONORIFICS.some((h) => after.replace(/^\s+/, '').startsWith(h))) continue;
      const boundary =
        after === '' ||
        /^[\s.,;:!?)\]]/.test(after) ||
        PARTICLES.some((p) => after.startsWith(p)) ||
        TITLES.some((t) => after.startsWith(t)) ||
        HONORIFICS.some((h) => after.startsWith(h)) ||
        // 이름 선언문의 종결 어미 ("○○○입니다/예요") — '입니다'는 조사 '이'가
        // 아니라 '입'으로 시작하므로 조사 경계에 걸리지 않는다 (v3 개발셋에서 발견)
        /^(?:입니다|이에요|예요)(?:[\s.,;:!?)\]]|$)/.test(after);
      if (!boundary) continue;
      if (COMMON_WORD_SPANS.has(surname + given)) continue;
      if (RELATION_WORDS.some((rw) => (surname + given).startsWith(rw))) continue;
      if (NAME_LABELS.includes(surname + given) || TITLES.includes(surname + given)) continue;
      if ((surname + given).endsWith('님') && TITLES.includes((surname + given).slice(0, -1))) continue;
      out.push({ type: 'NAME', start: i, end: i + surname.length + len, cue: 'surname+given' });
      break;
    }
  }
  const LABEL_STOP = new Set(['에게', '한테', '께', '문의', '확인', '전달', '회신', '부탁', '안내', '전화', '메일', '으로', '에게서', '부재', '부재중', '확인차', '안내문']);
  for (const label of NAME_LABELS) {
    let idx = text.indexOf(label);
    while (idx >= 0) {
      const m = text.slice(idx + label.length).match(/^[\s:은는이가]{0,3}([가-힣]{2,4})/);
      const startsWithSurname = m !== null && (SURNAME_SET.has(m[1][0]) || COMPOUND_SURNAMES.includes(m[1].slice(0, 2)));
      const startsWithRelation = m !== null && RELATION_WORDS.some((rw) => m[1].startsWith(rw));
      if (m && !LABEL_STOP.has(m[1]) && startsWithSurname && !startsWithRelation) {
        const start = idx + label.length + (m[0].length - m[1].length);
        const cand: KoreanCandidate = { type: 'NAME', start, end: start + m[1].length, cue: 'label' };
        if (!out.some((c) => overlaps(c, cand))) out.push(cand);
      }
      idx = text.indexOf(label, idx + 1);
    }
  }
  return out;
}

function addressCandidates(text: string): KoreanCandidate[] {
  const out: KoreanCandidate[] = [];
  const push = (start: number, end: number, cue: string): void => {
    const cand: KoreanCandidate = { type: 'ADDRESS', start, end, cue };
    if (!out.some((c) => overlaps(c, cand))) out.push(cand);
  };
  ROAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROAD_RE.exec(text)) !== null) {
    let start = m.index;
    let end = m.index + m[0].length;
    const before = text.slice(Math.max(0, start - 30), start);
    const sidoHit = SIDO.filter((s) => before.includes(s)).sort((a, b) => b.length - a.length)[0];
    if (sidoHit) start = Math.max(0, start - 30) + before.lastIndexOf(sidoHit);
    else {
      const sg = [...before.matchAll(/[가-힣]{1,6}(?:시|군|구)\s*/g)].pop();
      if (sg && sg.index !== void 0 && before.length - (sg.index + sg[0].length) <= 2) start = Math.max(0, start - 30) + sg.index;
    }
    const tail = text.slice(end, end + 16);
    const detail = tail.match(/^\s*(?:[가-힣]{1,8}(?:아파트|타워|빌딩|오피스텔|센터|병원|학교))?\s*(?:\d{1,4}동)?\s*(?:\d{1,5}호)?/);
    if (detail && detail[0].trim()) end += detail[0].length;
    push(start, end, 'road+number');
  }
  JIBUN_RE.lastIndex = 0;
  while ((m = JIBUN_RE.exec(text)) !== null) {
    let start = m.index;
    const before = text.slice(Math.max(0, start - 30), start);
    const sidoHit = SIDO.filter((s) => before.includes(s)).sort((a, b) => b.length - a.length)[0];
    if (sidoHit) start = Math.max(0, start - 30) + before.lastIndexOf(sidoHit);
    push(start, m.index + m[0].length, 'jibun');
  }
  for (const label of ADDRESS_LABELS) {
    let idx = text.indexOf(label);
    while (idx >= 0) {
      const seg = text.slice(idx + label.length, idx + label.length + 40);
      const mm = seg.match(/^[\s:은는]{0,3}([가-힣0-9\s]{4,35}?(?:로|길|대로|동|읍|면)\s*\d{1,4}(?:-\d{1,4})?)/);
      if (mm) {
        const start = idx + label.length + (mm[0].length - mm[1].length);
        push(start, start + mm[1].length, 'label');
      }
      idx = text.indexOf(label, idx + 1);
    }
  }
  return out;
}

function surnameTitleAt(text: string, i: number): { end: number } | null {
  let surname: string | null = null;
  for (const cs of COMPOUND_SURNAMES) {
    if (text.startsWith(cs, i)) {
      surname = cs;
      break;
    }
  }
  if (!surname && SURNAME_SET.has(text[i])) surname = text[i];
  if (!surname) return null;
  if (i > 0 && /[가-힣]/.test(text[i - 1]) && surname.length === 1) return null;
  const rest = text.slice(i + surname.length);
  const trimmed = rest.replace(/^\s+/, '');
  const spaceLen = rest.length - trimmed.length;
  const title = TITLES_BY_LENGTH.find((t) => trimmed.startsWith(t));
  if (!title) return null;
  return { end: i + surname.length + spaceLen + title.length };
}

function relationCandidates(text: string): KoreanCandidate[] {
  const out: KoreanCandidate[] = [];
  for (let i = 0; i < text.length; i++) {
    const m = surnameTitleAt(text, i);
    if (m) out.push({ type: 'RELATION', start: i, end: m.end, cue: 'surname+title' });
  }
  for (const rw of RELATION_WORDS) {
    let idx = text.indexOf(rw);
    while (idx >= 0) {
      let end = idx;
      while (end > 0 && text[end - 1] === ' ') end--;
      for (let s = Math.max(0, end - 8); s < end; s++) {
        const m = surnameTitleAt(text, s);
        if (m && m.end === end) {
          out.push({ type: 'RELATION', start: s, end: idx + rw.length, cue: 'relation-combo' });
          break;
        }
      }
      idx = text.indexOf(rw, idx + 1);
    }
  }
  return out;
}

function extractFromText(text: string, maxCandidates: number = MAX_CANDIDATES): { candidates: KoreanCandidate[]; overflow: number } {
  const all = [...nameCandidates(text), ...addressCandidates(text), ...relationCandidates(text)].sort((a, b) => a.start - b.start);
  const PRIO: Record<KoreanCandidateType, number> = { RELATION: 3, ADDRESS: 2, NAME: 1 };
  const kept: KoreanCandidate[] = [];
  for (const c of [...all].sort((a, b) => b.end - b.start - (a.end - a.start) || PRIO[b.type] - PRIO[a.type])) {
    if (!kept.some((k) => overlaps(k, c))) kept.push(c);
  }
  kept.sort((a, b) => a.start - b.start);
  return { candidates: kept.slice(0, maxCandidates), overflow: Math.max(0, kept.length - maxCandidates) };
}

export function extractCandidates(text: string, opts?: { maxCandidates?: number }): { candidates: KoreanCandidate[]; overflow: number } {
  if (typeof text !== 'string') return { candidates: [], overflow: 0 };
  const max = opts?.maxCandidates ?? MAX_CANDIDATES;
  const view = buildDetectionView(text);
  if (!view.hasInvisible) return extractFromText(text, max);
  const { candidates, overflow } = extractFromText(view.clean, max);
  return { candidates: candidates.map((c) => ({ ...c, ...viewSpanToOriginal(view, c.start, c.end) })), overflow };
}

function hasRelationSignal(text: string): boolean {
  if (RELATION_WORDS.some((w) => text.includes(w))) return true;
  const view = buildDetectionView(text);
  return view.hasInvisible && RELATION_WORDS.some((w) => view.clean.includes(w));
}

function scoreName(text: string, c: KoreanCandidate): number {
  const span = text.slice(c.start, c.end);
  const before = text.slice(Math.max(0, c.start - 14), c.start);
  const after = text.slice(c.end, c.end + 12);
  const surnameLen = COMPOUND_SURNAMES.includes(span.slice(0, 2)) ? 2 : 1;
  const given = span.slice(surnameLen);
  const afterT = after.replace(/^\s+/, '');
  let score = given.length >= 2 ? 0.4 : 0.3;
  if (c.cue === 'label') score += 0.5;
  if (c.cue === 'label' && !SURNAME_SET.has(span[0]) && !COMPOUND_SURNAMES.includes(span.slice(0, 2))) score -= 0.5;
  if (NAME_LABELS.some((l) => before.endsWith(l) || before.includes(`${l} `) || before.includes(`${l}:`) || before.includes(`${l}는`) || before.includes(`${l}은`))) score += 0.4;
  const titleAfter = TITLES.find((t) => afterT.startsWith(t));
  if (titleAfter) {
    score += 0.4;
    if (new RegExp(`^${titleAfter}(?:에게|한테|께|이|가|은|는|입니다|님)`).test(afterT)) score += 0.15;
  }
  const honAfter = HONORIFICS.find((h) => afterT.startsWith(h));
  if (honAfter) {
    score += 0.4;
    if (new RegExp(`^${honAfter}\\s*(?:에게|한테|께|이|가|은|는|과|와|앞으로)`).test(afterT)) score += 0.15;
  }
  if (given.length === 1 && (titleAfter || honAfter)) score += 0.1;
  if (/(담당|수령|예약|신청|보호|고객|환자|회원|학생)/.test(before)) score += 0.1;
  let l3Cue = false;
  if (/^(?:이|가)\s/.test(after) && /(입니다|합니다|맡습니다|했어요|했습니다|다녀|보냈|전달|발표|연락)/.test(text.slice(c.end, c.end + 16))) {
    score += 0.45;
    l3Cue = true;
  }
  if (/^\s말고/.test(after)) {
    score += 0.5;
    l3Cue = true;
  }
  if (/^,\s/.test(after) && /(부탁|확인|전달|보내|주세요)/.test(text.slice(c.end, c.end + 16))) {
    score += 0.5;
    l3Cue = true;
  }
  if (/^(?:을|를)\s/.test(after) && /(불러|초대|모시|데려|보내|연락|전화|소개|찾아|참석)/.test(text.slice(c.end, c.end + 20))) {
    score += 0.45;
    l3Cue = true;
  }
  if (/^(?:에게|한테|께)\s/.test(after) && /(보내|전달|연락|전화|주세요|부탁|물어)/.test(text.slice(c.end, c.end + 16))) {
    score += 0.45;
    l3Cue = true;
  }
  if (/^\s*(?:은|는)?\s*(?:참석|출석|참가)(?:\s|했|합|예|확)/.test(after)) {
    score += 0.5;
    l3Cue = true;
  }
  if (/^(?:랑|이랑|와|과)\s*(?:같이|함께)/.test(after)) {
    score += 0.45;
    l3Cue = true;
  } else if (/^(?:랑|이랑)\s/.test(after) && /(먹었|만났|갔|다녀|이야기|통화|근무|일했)/.test(text.slice(c.end, c.end + 16))) {
    score += 0.45;
    l3Cue = true;
  }
  if (/(입니다|이에요|예요|보냈|전달|연락|전화|메일|보내|주세요|께|에게|한테)/.test(after)) score += 0.05;
  const labelBefore = NAME_LABELS.some((l) => before.includes(l));
  const labelImmediate = NAME_LABELS.some((l) => new RegExp(`${l}[\\s:은는이가]{0,3}$`).test(before));
  const strongCtx = !!(titleAfter || honAfter || c.cue === 'label' || l3Cue || labelBefore);
  if (HOMOGRAPH_WORDS.has(given)) score -= labelImmediate ? 0 : strongCtx ? 0.05 : 0.25;
  if (NON_NAME_COMPOUNDS.some((w) => text.startsWith(w, c.start))) score -= 0.55;
  if (/(김밥|김치|김해|김포|이천|박물관)/.test(span + after.slice(0, 2))) score -= 0.55;
  return Math.max(0, Math.min(1, score));
}

function scoreAddress(text: string, c: KoreanCandidate): number {
  const span = text.slice(c.start, c.end);
  const before = text.slice(Math.max(0, c.start - 14), c.start);
  let score = 0.4;
  if (c.cue === 'label') score += 0.35;
  if (ADDRESS_LABELS.some((l) => before.includes(l))) score += 0.3;
  if (SIDO.some((s) => span.includes(s))) score += 0.2;
  if (/(?:시|군|구)\s/.test(span) || /(?:시|군|구)[가-힣]/.test(span)) score += 0.1;
  if (/\d{1,4}(?:-\d{1,4})?\s*(?:입니다|입니다\.|예요|이에요|으로|로\s|에\s|$)/.test(text.slice(c.start, c.end + 8))) score += 0.05;
  if (/\d+동|\d+호/.test(span)) score += 0.15;
  if (c.cue === 'jibun') score += 0.15;
  if (!/\d/.test(span)) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}

function scoreRelation(text: string, c: KoreanCandidate): number {
  let score = 0.55;
  if (c.cue === 'relation-combo') score += 0.45;
  const before = text.slice(Math.max(0, c.start - 12), c.start);
  const after = text.slice(c.end, c.end + 10);
  const afterWide = text.slice(c.end, c.end + 20);
  if (/(우리|담당|거래처|영업팀|개발팀|프로젝트|소속|팀의)/.test(before + text.slice(c.start, c.end))) score += 0.2;
  if (/(?:이|가|에게|한테|께|은|는|이\s|께\s)/.test(after.slice(0, 3)) || /^(?:이|가|에게|한테|께|은|는)/.test(after)) score += 0.15;
  if (ACTION_RE.test(afterWide)) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

function scoreOne(text: string, c: KoreanCandidate): number {
  return c.type === 'NAME' ? scoreName(text, c) : c.type === 'ADDRESS' ? scoreAddress(text, c) : scoreRelation(text, c);
}

function scoreCandidates(text: string, candidates: KoreanCandidate[]): ScoredKoreanCandidate[] {
  const view = typeof text === 'string' ? buildDetectionView(text) : null;
  if (!view || !view.hasInvisible) return candidates.map((c) => ({ ...c, score: scoreOne(text, c) }));
  return candidates.map((c) => {
    const mapped = originalSpanToView(view, c.start, c.end);
    if (!mapped) return { ...c, score: scoreOne(text, c) };
    return { ...c, score: scoreOne(view.clean, { ...c, ...mapped }) };
  });
}

export function actionFor(score: number, type: KoreanCandidateType, sensitiveSource: boolean): KoreanAction {
  const t = THRESHOLDS[type];
  if (score >= t.tokenize) return 'tokenize';
  if (score >= t.gray) return sensitiveSource ? 'tokenize' : 'gray';
  return 'pass';
}

export function detectKorean(text: string, opts?: { sensitiveSource?: boolean }): KoreanFinding[] {
  const { candidates, overflow } = extractCandidates(text);
  const scored = scoreCandidates(text, candidates);
  const out: KoreanFinding[] = [];
  for (const s of scored) {
    if (actionFor(s.score, s.type, !!opts?.sensitiveSource) === 'tokenize') {
      out.push({ type: s.type, level: 2, start: s.start, end: s.end, source: 'context', score: s.score });
    }
  }
  return out;
}

export function judgeKorean(
  text: string,
  opts?: { sensitiveSource?: boolean; maxCandidates?: number },
): { scored: ScoredKoreanCandidate[]; actions: KoreanAction[]; overflow: number; relationSignal: boolean } {
  const { candidates, overflow } = extractCandidates(text, { maxCandidates: opts?.maxCandidates });
  const scored = scoreCandidates(text, candidates);
  return {
    scored,
    actions: scored.map((s) => actionFor(s.score, s.type, !!opts?.sensitiveSource)),
    overflow,
    relationSignal: hasRelationSignal(text),
  };
}
