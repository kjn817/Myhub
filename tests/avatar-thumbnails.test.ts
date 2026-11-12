/// <reference types="jest" />
/**
 * 아바타 썸네일 회귀 테스트 (2026-11-13 성능 4라운드).
 *
 * 배경: 아바타 4장이 1600×1600 원본(합 1.15MB) 그대로 로드됐는데
 * 표시 크기는 최대 64px(채팅 비서 카드)이다. 128px 썸네일(합 10.9KB)로
 * 교체해 부팅·채팅 로딩 바이트를 줄였다. 128px이면 2x 레티나까지 안전하다.
 *
 * 이 테스트가 검증하는 성질:
 * - 런타임 코드가 원본 1600px 아바타를 다시 참조하면 실패한다.
 * - 썸네일 4장이 존재하고 각 40KB 미만이다 (원본이 그 크기로 못 들어간다).
 * - 썸네일이 하나라도 미참조면 실패한다 (죽은 에셋 방지).
 * - 참조 0건이던 builder/concierge/keeper.webp가 부활하면 실패한다.
 * - 매니페스트가 썸네일을 싣고 원본을 빼고 있다 (배포 집합 일치).
 *
 * 카나리아: public/에 원본 경로를 적은 임시 파일을 두면 첫 테스트가 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PERSONAS = ['rumi', 'echo', 'nova', 'cali'];
const DEAD = ['builder', 'concierge', 'keeper'];

function listTextFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['vendor', 'pdf-viewer', 'rhwp-studio', '.scratch', 'avatars'].includes(ent.name)) continue;
      listTextFiles(p, out);
    } else if (/\.(js|html|ts|css)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function grepRuntime(re: RegExp): string[] {
  const hits: string[] = [];
  for (const dir of [PUBLIC, path.join(ROOT, 'src')]) {
    for (const f of listTextFiles(dir)) {
      if (re.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(ROOT, f));
    }
  }
  return hits;
}

describe('avatar thumbnails', () => {
  it('런타임 코드가 원본 1600px 아바타를 참조하지 않는다', () => {
    const hits = grepRuntime(/\/avatars\/(rumi|echo|nova|cali)\.webp/);
    // -128.webp는 위 정규식에 안 걸린다 (rumi 뒤에 바로 .webp가 와야 함).
    expect(hits).toEqual([]);
  });

  it('썸네일 4장이 존재하고 각 40KB 미만이다', () => {
    for (const name of PERSONAS) {
      const p = path.join(PUBLIC, 'avatars', `${name}-128.webp`);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeLessThan(40 * 1024);
      expect(fs.statSync(p).size).toBeGreaterThan(512);
    }
  });

  it('썸네일 4장이 모두 최소 1곳에서 참조된다', () => {
    for (const name of PERSONAS) {
      const hits = grepRuntime(new RegExp(`/avatars/${name}-128\\.webp`));
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it('미사용 아바타(builder/concierge/keeper)는 파일도 참조도 없다', () => {
    for (const name of DEAD) {
      expect(fs.existsSync(path.join(PUBLIC, 'avatars', `${name}.webp`))).toBe(false);
      const hits = grepRuntime(new RegExp(`/avatars/${name}\\.webp`));
      expect(hits).toEqual([]);
    }
  });

  it('정적 에셋 매니페스트가 썸네일만 싣는다', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/static-assets.json'), 'utf8'),
    ) as { files?: string[]; versioned?: string[] };
    const all = [...(manifest.files || []), ...(manifest.versioned || [])];
    for (const name of PERSONAS) {
      expect(all).toContain(`/avatars/${name}-128.webp`);
      expect(all).not.toContain(`/avatars/${name}.webp`);
    }
    for (const name of DEAD) {
      expect(all).not.toContain(`/avatars/${name}.webp`);
    }
  });
});
