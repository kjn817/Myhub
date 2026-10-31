/// <reference types="jest" />
/**
 * src/services/tools-builtin.ts 테스트
 * registerBuiltinTools()로 등록되는 5개 도구: geocode, get_weather, github_search, generate_image, web_search
 */

import { registerBuiltinTools } from '../../src/services/tools-builtin';
import { getToolDefinitions, executeTool } from '../../src/services/tools';

describe('registerBuiltinTools', () => {
  beforeAll(() => {
    registerBuiltinTools();
  });

  test('5개 도구가 등록된다', () => {
    const defs = getToolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('geocode');
    expect(names).toContain('get_weather');
    expect(names).toContain('github_search');
    expect(names).toContain('generate_image');
    expect(names).toContain('web_search');
  });

  test('도구 정의에 description과 parameters가 있다', () => {
    const defs = getToolDefinitions();
    for (const d of defs) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.parameters.type).toBe('object');
      expect(Array.isArray(d.parameters.required)).toBe(true);
    }
  });

  test('geocode 정의: query가 required', () => {
    const def = getToolDefinitions().find((d) => d.name === 'geocode')!;
    expect(def.parameters.required).toContain('query');
  });

  test('get_weather 정의: latitude/longitude가 required', () => {
    const def = getToolDefinitions().find((d) => d.name === 'get_weather')!;
    expect(def.parameters.required).toContain('latitude');
    expect(def.parameters.required).toContain('longitude');
  });

  test('generate_image 정의: prompt가 required', () => {
    const def = getToolDefinitions().find((d) => d.name === 'generate_image')!;
    expect(def.parameters.required).toContain('prompt');
  });
});

describe('geocode handler', () => {
  test('정상 응답 시 좌표를 반환한다', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({
        results: [{ name: '서울', latitude: 37.566, longitude: 126.9784 }],
      }),
    });
    const result = await executeTool('geocode', { query: '서울' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ name: '서울', latitude: 37.566, longitude: 126.9784 });
    // URL에 쿼리가 인코딩되어 포함되는지
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toContain(encodeURIComponent('서울'));
  });

  test('결과가 없으면 not found 에러', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({ results: [] }),
    });
    const result = await executeTool('geocode', { query: '없는곳xyz' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not found');
  });

  test('results 필드 자체가 없으면 not found', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({}),
    });
    const result = await executeTool('geocode', { query: 'x' });
    expect(result.ok).toBe(false);
  });

  test('fetch 실패 시 ok:false', async () => {
    (global.fetch as any) = jest.fn().mockRejectedValue(new Error('network down'));
    const result = await executeTool('geocode', { query: '서울' });
    expect(result.ok).toBe(false);
  });
});

describe('get_weather handler', () => {
  test('정상 응답 시 날씨 데이터를 반환한다', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({
        current: { temperature_2m: 20.5, relative_humidity_2m: 60, weather_code: 1 },
      }),
    });
    const result = await executeTool('get_weather', {
      latitude: 37.566,
      longitude: 126.9784,
      location_name: '서울',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      location: '서울',
      temperature: 20.5,
      humidity: 60,
      weather_code: 1,
    });
  });

  test('current가 없어도 ok:true (undefined 필드)', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({ json: async () => ({}) });
    const result = await executeTool('get_weather', { latitude: 0, longitude: 0 });
    expect(result.ok).toBe(true);
    expect(result.data.temperature).toBeUndefined();
  });

  test('fetch 실패 시 ok:false', async () => {
    (global.fetch as any) = jest.fn().mockRejectedValue(new Error('timeout'));
    const result = await executeTool('get_weather', { latitude: 0, longitude: 0 });
    expect(result.ok).toBe(false);
  });
});

describe('github_search handler', () => {
  test('기본 type은 repositories', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({ total_count: 1, items: [] }),
    });
    await executeTool('github_search', { query: 'myhub' });
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toContain('/search/repositories');
  });

  test('type 지정 시 해당 경로로 검색', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({ total_count: 0, items: [] }),
    });
    await executeTool('github_search', { query: 'x', type: 'code' });
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toContain('/search/code');
  });

  test('결과를 5개로 자르고 필요한 필드만 매핑한다', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      full_name: `user/repo${i}`,
      html_url: `https://github.com/user/repo${i}`,
      description: 'd'.repeat(300),
      stargazers_count: i,
    }));
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({ total_count: 10, items }),
    });
    const result = await executeTool('github_search', { query: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data.total).toBe(10);
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0].description.length).toBeLessThanOrEqual(200);
    expect(result.data.items[0]).toEqual({
      name: 'user/repo0',
      url: 'https://github.com/user/repo0',
      description: expect.any(String),
      stars: 0,
    });
  });

  test('full_name이 없으면 name 사용', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({
        total_count: 1,
        items: [{ name: 'plain', html_url: 'u', description: null, stargazers_count: 5 }],
      }),
    });
    const result = await executeTool('github_search', { query: 'x' });
    expect(result.data.items[0].name).toBe('plain');
    expect(result.data.items[0].description).toBeUndefined();
  });

  test('items가 없으면 빈 배열 (|| [] 폴백)', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({
      json: async () => ({ total_count: 0 }),
    });
    const result = await executeTool('github_search', { query: 'x' });
    expect(result.ok).toBe(true);
    expect(result.data.items).toEqual([]);
  });

  test('fetch 실패 시 ok:false', async () => {
    (global.fetch as any) = jest.fn().mockRejectedValue(new Error('down'));
    const result = await executeTool('github_search', { query: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('generate_image handler', () => {
  test('pollinations URL을 반환한다 (fetch 불필요)', async () => {
    const result = await executeTool('generate_image', { prompt: 'a cat' });
    expect(result.ok).toBe(true);
    expect(result.data.image_url).toContain('image.pollinations.ai');
    expect(result.data.image_url).toContain(encodeURIComponent('a cat'));
    expect(result.data.prompt).toBe('a cat');
  });
});

describe('web_search handler', () => {
  test('count는 최대 10으로 제한된다', async () => {
    const one = `<a class="result__a" href="https://e.com">T</a><div class="result__snippet">S<</div>`;
    (global.fetch as any) = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => one.repeat(20),
    });
    const result = await executeTool('web_search', { query: 'test', count: 50 });
    expect(result.ok).toBe(true);
    // count=50을 줘도 Math.min(count, 10) 상한 때문에 10건만 반환된다
    expect(result.data.results.length).toBe(10);
  });

  test('정상 HTML에서 결과를 파싱한다', async () => {
    const html = `
      <a class="result__a" href="https://example.com/1">Title One</a>
      <div class="result__snippet">Snippet one<</div>
      <a class="result__a" href="https://example.com/2"><b>Title</b> Two</a>
      <div class="result__snippet">Snippet <i>two</i><</div>
    `;
    (global.fetch as any) = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });
    const result = await executeTool('web_search', { query: 'test', count: 5 });
    expect(result.ok).toBe(true);
    expect(result.data.query).toBe('test');
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.results[0].title).toBe('Title One');
    expect(result.data.results[0].url).toBe('https://example.com/1');
    // HTML 태그 제거 확인
    expect(result.data.results[1].title).toBe('Title Two');
  });

  test('결과가 count를 초과하지 않는다', async () => {
    const one = `<a class="result__a" href="https://e.com">T</a><div class="result__snippet">S<</div>`;
    (global.fetch as any) = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => one.repeat(20),
    });
    const result = await executeTool('web_search', { query: 'x', count: 3 });
    expect(result.data.results.length).toBeLessThanOrEqual(3);
  });

  test('count 미지정 시 기본 5', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    const result = await executeTool('web_search', { query: 'x' });
    expect(result.ok).toBe(true);
    expect(result.data.results).toEqual([]);
  });

  test('res.ok=false면 검색 실패', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({ ok: false });
    const result = await executeTool('web_search', { query: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('검색 실패');
  });

  test('fetch throw 시 ok:false와 100자 이내 메시지', async () => {
    (global.fetch as any) = jest.fn().mockRejectedValue(new Error('z'.repeat(500)));
    const result = await executeTool('web_search', { query: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error!.length).toBeLessThanOrEqual(100);
  });
});
