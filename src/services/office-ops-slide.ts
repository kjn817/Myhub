import { MAX_OPS } from './office-ops-shared';

export interface SlideTextReplaceParams {
  text: string;
  with: string;
  matchCase?: boolean;
  wholeWords?: boolean;
}

export interface SlideTextSetParams {
  id: number;
  text: string;
  slide?: number;
  cell?: [number, number];
}

export interface SlideInsertTextBoxParams {
  text: string;
  slide?: number;
  rect?: [number, number, number, number];
}

export interface SlideNewParams {
  layout?: string;
  title?: string;
  body?: string;
  at?: number;
}

export type SlideOp =
  | { id: 'text.replace'; params: SlideTextReplaceParams }
  | { id: 'text.set'; params: SlideTextSetParams }
  | { id: 'insert.textBox'; params: SlideInsertTextBoxParams }
  | { id: 'slide.new'; params: SlideNewParams };

const SLIDE_COMMAND_WHITELIST = new Set(['text.replace', 'text.set', 'insert.textBox', 'slide.new']);
const SLIDE_LAYOUT_KINDS = new Set([
  'title',
  'titleAndContent',
  'sectionHeader',
  'twoContent',
  'comparison',
  'titleOnly',
  'blank',
  'contentWithCaption',
  'pictureWithCaption',
]);

function slideIndexParam(v: any): number | null {
  return Number.isInteger(v) && v >= 0 && v <= 999 ? v : null;
}

export function validateSlideOps(raw: unknown): { ops: SlideOp[]; errors: string[] } {
  const errors: string[] = [];
  const ops: SlideOp[] = [];
  if (!Array.isArray(raw)) return { ops, errors: ['연산 목록이 배열이 아닙니다'] };
  if (raw.length > MAX_OPS) errors.push(`연산이 너무 많습니다 (최대 ${MAX_OPS}개)`);
  for (const item of raw.slice(0, MAX_OPS)) {
    const o = item as { id?: unknown; params?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string') {
      errors.push('형식이 잘못된 연산을 건너뜀');
      continue;
    }
    if (!SLIDE_COMMAND_WHITELIST.has(o.id)) {
      errors.push(`알 수 없는 연산: ${o.id}`);
      continue;
    }
    const p = o.params as Record<string, any> | null;
    if (!p || typeof p !== 'object') {
      errors.push(`${o.id}: 파라미터가 올바르지 않음`);
      continue;
    }
    if (o.id === 'text.replace') {
      if (typeof p.text !== 'string' || !p.text || p.text.length > 200 || typeof p.with !== 'string' || p.with.length > 2e3) {
        errors.push('text.replace: 찾을/바꿀 문자열이 올바르지 않음');
        continue;
      }
      const params: SlideTextReplaceParams = { text: p.text, with: p.with };
      if (p.matchCase === true) params.matchCase = true;
      if (p.wholeWords === true) params.wholeWords = true;
      ops.push({ id: 'text.replace', params });
      continue;
    }
    if (o.id === 'text.set') {
      if (!Number.isInteger(p.id) || p.id < 1 || p.id > 4294967295 || typeof p.text !== 'string' || p.text.length > 2e3) {
        errors.push('text.set: 도형 id/텍스트가 올바르지 않음');
        continue;
      }
      const params: SlideTextSetParams = { id: p.id, text: p.text };
      if (p.slide !== void 0) {
        const s = slideIndexParam(p.slide);
        if (s === null) {
          errors.push('text.set: 슬라이드 번호가 올바르지 않음');
          continue;
        }
        params.slide = s;
      }
      if (p.cell !== void 0) {
        const c = p.cell;
        if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) || (c[0] as number) < 0 || (c[0] as number) > 99 || (c[1] as number) < 0 || (c[1] as number) > 99) {
          errors.push('text.set: 표 셀 위치가 올바르지 않음');
          continue;
        }
        params.cell = [c[0] as number, c[1] as number];
      }
      ops.push({ id: 'text.set', params });
      continue;
    }
    if (o.id === 'insert.textBox') {
      if (typeof p.text !== 'string' || !p.text || p.text.length > 2e3) {
        errors.push('insert.textBox: 텍스트가 올바르지 않음');
        continue;
      }
      const params: SlideInsertTextBoxParams = { text: p.text };
      if (p.slide !== void 0) {
        const s = slideIndexParam(p.slide);
        if (s === null) {
          errors.push('insert.textBox: 슬라이드 번호가 올바르지 않음');
          continue;
        }
        params.slide = s;
      }
      if (p.rect !== void 0) {
        const r = p.rect;
        if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && Number.isFinite(n)) || (r[0] as number) < 0 || (r[0] as number) > 5e3 || (r[1] as number) < 0 || (r[1] as number) > 5e3 || (r[2] as number) < 1 || (r[2] as number) > 5e3 || (r[3] as number) < 1 || (r[3] as number) > 5e3) {
          errors.push('insert.textBox: 위치/크기가 올바르지 않음');
          continue;
        }
        params.rect = [r[0] as number, r[1] as number, r[2] as number, r[3] as number];
      }
      ops.push({ id: 'insert.textBox', params });
      continue;
    }
    const params: SlideNewParams = {};
    if (p.layout !== void 0) {
      if (typeof p.layout !== 'string' || !SLIDE_LAYOUT_KINDS.has(p.layout)) {
        errors.push('slide.new: 레이아웃 종류가 올바르지 않음');
        continue;
      }
      params.layout = p.layout;
    }
    if (p.title !== void 0) {
      if (typeof p.title !== 'string' || p.title.length > 200) {
        errors.push('slide.new: 제목이 올바르지 않음');
        continue;
      }
      params.title = p.title;
    }
    if (p.body !== void 0) {
      if (typeof p.body !== 'string' || p.body.length > 4e3) {
        errors.push('slide.new: 본문이 올바르지 않음');
        continue;
      }
      params.body = p.body;
    }
    if (p.at !== void 0) {
      const s = slideIndexParam(p.at);
      if (s === null) {
        errors.push('slide.new: 위치가 올바르지 않음');
        continue;
      }
      params.at = s;
    }
    ops.push({ id: 'slide.new', params });
  }
  return { ops, errors };
}

export const SLIDE_OPS_GUIDE = [
  '\uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uC5F0\uC0B0 (\uC2AC\uB77C\uC774\uB4DC \uC5D4\uC9C4 \uBA85\uB839 \u2014 \uB2E4\uB978 \uC571\uACFC \uB2EC\uB9AC {"id","params"} \uD615\uD0DC\uB2E4). \uC2A4\uB0C5\uC0F7\uC758 slides \uBC30\uC5F4\uC5D0 \uC2AC\uB77C\uC774\uB4DC\uBCC4 \uB3C4\uD615 \uBAA9\uB85D\uC774 \uB4E4\uC5B4 \uC788\uB2E4 \u2014 \uAC01 \uB3C4\uD615\uC740 id, \uC885\uB958(kind), \uC790\uB9AC\uD45C\uC2DC\uC790 \uC885\uB958(placeholder: title/body \uB4F1), \uD604\uC7AC \uD14D\uC2A4\uD2B8(text, \uBE44\uC5B4 \uC788\uC73C\uBA74 "")\uB97C \uAC00\uC9C4\uB2E4:',
  '- {"id":"text.set","params":{"id":\uB3C4\uD615id,"text":"\uC0C8 \uD14D\uC2A4\uD2B8"}} \u2014 \uADF8 \uB3C4\uD615 \uD558\uB098\uC758 \uC804\uCCB4 \uD14D\uC2A4\uD2B8\uB97C \uBC14\uAFBC\uB2E4. \uC81C\uBAA9\uC774\uB098 \uBCF8\uBB38 \uC790\uB9AC\uD45C\uC2DC\uC790\uC758 \uB0B4\uC6A9\uC744 \uB123\uAC70\uB098 \uBC14\uAFC0 \uB54C \uC4F4\uB2E4. \uBE44\uC5B4 \uC788\uB294 \uC790\uB9AC\uD45C\uC2DC\uC790\uB3C4 \uC2A4\uB0C5\uC0F7\uC5D0 text:""\uC778 \uB3C4\uD615\uC73C\uB85C \uBCF4\uC774\uBBC0\uB85C, \uC81C\uBAA9\uC744 \uB123\uC73C\uB824\uBA74 \uADF8 \uC790\uB9AC\uD45C\uC2DC\uC790 \uB3C4\uD615\uC758 id\uB85C text.set\uC744 \uC4F0\uBA74 \uB41C\uB2E4. \uC81C\uBAA9 \uC790\uB9AC\uD45C\uC2DC\uC790\uB294 placeholder\uAC00 "title" \uB610\uB294 "ctrTitle"(\uAC00\uC6B4\uB370 \uC81C\uBAA9) \uB458 \uC911 \uD558\uB098\uB85C \uBCF4\uC778\uB2E4 \u2014 \uB458 \uB2E4 \uC81C\uBAA9\uC774\uB2E4. \uD45C \uC140\uC774\uBA74 params\uC5D0 "cell":[\uD589,\uC5F4]\uC744 \uB354\uD55C\uB2E4.',
  '- {"id":"text.replace","params":{"text":"\uCC3E\uC744 \uB9D0","with":"\uBC14\uAFC0 \uB9D0"}} \u2014 \uBAA8\uB4E0 \uC2AC\uB77C\uC774\uB4DC\uC758 \uB3C4\uD615 \uD14D\uC2A4\uD2B8\xB7\uD45C \uC140\xB7\uBC1C\uD45C\uC790 \uB178\uD2B8\uC5D0\uC11C \uC77C\uCE58\uD558\uB294 \uB9D0\uC744 \uC804\uBD80 \uBC14\uAFBC\uB2E4. \uB300\uC18C\uBB38\uC790\uB97C \uAD6C\uBD84\uD558\uB824\uBA74 params\uC5D0 "matchCase":true, \uB2E8\uC5B4 \uB2E8\uC704\uB85C\uB9CC \uCC3E\uC73C\uB824\uBA74 "wholeWords":true\uB97C \uB123\uB294\uB2E4. \uCC3E\uC744 \uB9D0\uC740 \uC2A4\uB0C5\uC0F7\uC5D0 \uC2E4\uC81C\uB85C \uC788\uB294 \uBB38\uAD6C\uB098 \uC0AC\uC6A9\uC790\uAC00 \uC9C0\uC2DC\uC5D0\uC11C \uB9D0\uD55C \uBB38\uAD6C\uB97C \uC815\uD655\uD788 \uADF8\uB300\uB85C \uC4F4\uB2E4.',
  '- {"id":"insert.textBox","params":{"text":"\uB123\uC744 \uB9D0","slide":0}} \u2014 \uADF8 \uC2AC\uB77C\uC774\uB4DC(0\uBD80\uD130 \uC13C \uBC88\uD638)\uC5D0 \uC0C8 \uD14D\uC2A4\uD2B8 \uC0C1\uC790\uB97C \uCD94\uAC00\uD55C\uB2E4. \uC704\uCE58\xB7\uD06C\uAE30 "rect":[x,y,\uB108\uBE44,\uB192\uC774](pt \uB2E8\uC704)\uB97C \uB123\uC744 \uC218 \uC788\uACE0, \uC5C6\uC73C\uBA74 \uAE30\uBCF8 \uC704\uCE58\uC5D0 \uC0DD\uAE34\uB2E4.',
  '- {"id":"slide.new","params":{"layout":"titleAndContent","title":"\uC81C\uBAA9","body":"\uBCF8\uBB38"}} \u2014 \uC2AC\uB77C\uC774\uB4DC\uB97C \uCD94\uAC00\uD55C\uB2E4. layout\uC740 title, titleAndContent, sectionHeader, twoContent, comparison, titleOnly, blank, contentWithCaption, pictureWithCaption \uC911 \uD558\uB098\uC774\uACE0, title\xB7body\uB294 \uC0DD\uB7B5\uD560 \uC218 \uC788\uB2E4.',
  "- text.set\uC758 id\uB294 \uBC18\uB4DC\uC2DC \uC2A4\uB0C5\uC0F7\uC5D0 \uC788\uB294 \uB3C4\uD615 id\uB97C \uC4F4\uB2E4. \uC5C6\uB294 id\uB97C \uC9C0\uC5B4\uB0B4\uC9C0 \uC54A\uB294\uB2E4.",
  "- \uC2AC\uB77C\uC774\uB4DC \uC0AD\uC81C\xB7\uC774\uB3D9, \uB3C4\uD615 \uC0AD\uC81C\xB7\uC774\uB3D9\xB7\uC11C\uC2DD \uBCC0\uACBD \uAC19\uC740 \uADF8 \uBC16\uC758 \uAD6C\uC870 \uBCC0\uACBD\uC740 \uD560 \uC218 \uC5C6\uB2E4. \uADF8\uB7F0 \uC9C0\uC2DC\uBA74 \uC5F0\uC0B0 \uC5C6\uC774 \uC774\uC720\uB97C \uC124\uBA85\uD55C\uB2E4."
].join('\n');
