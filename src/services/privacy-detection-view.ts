export interface DetectionView {
  clean: string;
  orig: number[];
  cleanPos: number[];
  hasInvisible: boolean;
}

const CF_RE = /\p{Cf}/u;

function isInvisibleFormat(cp: number, ch: string): boolean {
  if (cp === 6158) return true;
  if (cp >= 65024 && cp <= 65039) return true;
  if (cp >= 917760 && cp <= 917999) return true;
  return CF_RE.test(ch);
}

export function buildDetectionView(text: string): DetectionView {
  const orig: number[] = [];
  const cleanPos = new Array<number>(text.length).fill(-1);
  let clean = '';
  let hasInvisible = false;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const width = cp > 65535 ? 2 : 1;
    if (isInvisibleFormat(cp, text.slice(i, i + width))) {
      hasInvisible = true;
    } else {
      for (let k = 0; k < width; k++) {
        cleanPos[i + k] = clean.length + k;
        orig.push(i + k);
      }
      clean += text.slice(i, i + width);
    }
    i += width;
  }
  return { clean, orig, cleanPos, hasInvisible };
}

export function viewSpanToOriginal(view: DetectionView, s: number, e: number): { start: number; end: number } {
  return { start: view.orig[s], end: view.orig[e - 1] + 1 };
}

export function originalSpanToView(view: DetectionView, s: number, e: number): { start: number; end: number } | null {
  let cs = -1;
  let ce = -1;
  for (let i = s; i < e; i++) {
    if (view.cleanPos[i] >= 0) {
      if (cs < 0) cs = view.cleanPos[i];
      ce = view.cleanPos[i] + 1;
    }
  }
  return cs < 0 ? null : { start: cs, end: ce };
}
