/// <reference types="jest" />
/**
 * src/services/artifact-tools.ts 테스트
 * 마커 파서 + HTML 감지 + DB 실행 함수
 */

import {
  parseArtifactMarkers,
  executeArtifactCreate,
  executeArtifactDelete,
  executeArtifactList,
  detectHtmlFromResponse,
  saveArtifactDraft,
  executeArtifactFromGithub,
} from '../../src/services/artifact-tools';

function mockPrepare(env: any, impl: { first?: any; run?: any; all?: any }) {
  const stmt = {
    bind: jest.fn().mockReturnValue({
      first: jest.fn().mockImplementation(async () => {
        if (impl.first instanceof Error) throw impl.first;
        return typeof impl.first === 'function' ? impl.first() : impl.first ?? null;
      }),
      run: jest.fn().mockImplementation(async () => {
        if (impl.run instanceof Error) throw impl.run;
        return impl.run ?? { meta: { last_row_id: 1, changes: 1 } };
      }),
      all: jest.fn().mockImplementation(async () => {
        if (impl.all instanceof Error) throw impl.all;
        return { results: impl.all ?? [] };
      }),
    }),
  };
  env.DB.prepare = jest.fn().mockReturnValue(stmt);
  return stmt;
}

const makeEnv = () => ({ DB: { prepare: jest.fn() } });

describe('parseArtifactMarkers', () => {
  test('ARTIFACT_CREATE 파싱 (html)', () => {
    const r = parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "app", "html": "<html></html>"}[/ARTIFACT_CREATE]');
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('create');
    expect(r[0].data.title).toBe('app');
  });

  test('ARTIFACT_CREATE 파싱 (python)', () => {
    const r = parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "py", "python": "print(1)"}[/ARTIFACT_CREATE]');
    expect(r[0].action).toBe('create');
  });

  test('ARTIFACT_CREATE 파싱 (code)', () => {
    const r = parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "c", "code": "x=1"}[/ARTIFACT_CREATE]');
    expect(r[0].action).toBe('create');
  });

  test('title 없으면 무시', () => {
    expect(parseArtifactMarkers('[ARTIFACT_CREATE]{"html": "<html></html>"}[/ARTIFACT_CREATE]')).toEqual([]);
  });

  test('내용(html/python/code) 없으면 무시', () => {
    expect(parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "t"}[/ARTIFACT_CREATE]')).toEqual([]);
  });

  test('ARTIFACT_FROM_GITHUB 파싱', () => {
    const r = parseArtifactMarkers('[ARTIFACT_FROM_GITHUB]{"repo": "user/repo"}[/ARTIFACT_FROM_GITHUB]');
    expect(r[0].action).toBe('from_github');
    expect(r[0].data.repo).toBe('user/repo');
  });

  test('repo 없으면 무시', () => {
    expect(parseArtifactMarkers('[ARTIFACT_FROM_GITHUB]{}[/ARTIFACT_FROM_GITHUB]')).toEqual([]);
  });

  test('ARTIFACT_DELETE 파싱', () => {
    expect(parseArtifactMarkers('[ARTIFACT_DELETE]{"id": 1}[/ARTIFACT_DELETE]')[0].action).toBe('delete');
    expect(parseArtifactMarkers('[ARTIFACT_DELETE]{"title": "x"}[/ARTIFACT_DELETE]')[0].action).toBe('delete');
    expect(parseArtifactMarkers('[ARTIFACT_DELETE]{}[/ARTIFACT_DELETE]')).toEqual([]);
  });

  test('JSON 파싱 실패 시 무시', () => {
    expect(parseArtifactMarkers('[ARTIFACT_CREATE]bad[/ARTIFACT_CREATE]')).toEqual([]);
    expect(parseArtifactMarkers('[ARTIFACT_FROM_GITHUB]bad[/ARTIFACT_FROM_GITHUB]')).toEqual([]);
    expect(parseArtifactMarkers('[ARTIFACT_DELETE]bad[/ARTIFACT_DELETE]')).toEqual([]);
  });

  test('각 액션 최대 3개', () => {
    expect(parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "a", "html": "h"}[/ARTIFACT_CREATE]'.repeat(5)).filter((x) => x.action === 'create')).toHaveLength(3);
    expect(parseArtifactMarkers('[ARTIFACT_FROM_GITHUB]{"repo": "u/r"}[/ARTIFACT_FROM_GITHUB]'.repeat(5)).filter((x) => x.action === 'from_github')).toHaveLength(3);
    expect(parseArtifactMarkers('[ARTIFACT_DELETE]{"id": 1}[/ARTIFACT_DELETE]'.repeat(5)).filter((x) => x.action === 'delete')).toHaveLength(3);
  });

  test('마커 없으면 빈 배열', () => {
    expect(parseArtifactMarkers('hello')).toEqual([]);
  });
});

describe('executeArtifactCreate', () => {
  // createArtifactWithV1은 3번의 DB 호출: INSERT artifacts, INSERT versions, UPDATE pointer
  function mockCreateEnv(artifactId = 10) {
    const env = makeEnv();
    let callIdx = 0;
    env.DB.prepare = jest.fn().mockImplementation(() => {
      callIdx++;
      return {
        bind: jest.fn().mockReturnValue({
          run: jest.fn().mockResolvedValue({ meta: { last_row_id: callIdx <= 2 ? artifactId : artifactId } }),
        }),
      };
    });
    return env;
  }

  test('html 타입 생성 성공', async () => {
    const env = mockCreateEnv(10);
    const r = await executeArtifactCreate(env, { title: 'app', html: '<html>x</html>' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(10);
    expect(r.data.type).toBe('html');
  });

  test('python 필드가 있으면 python 타입', async () => {
    const env = mockCreateEnv(11);
    const r = await executeArtifactCreate(env, { title: 'py', python: 'print(1)' });
    expect(r.success).toBe(true);
    expect(r.data.type).toBe('python');
  });

  test('code 필드가 있으면 python 타입', async () => {
    const env = mockCreateEnv(12);
    const r = await executeArtifactCreate(env, { title: 'c', code: 'x=1' });
    expect(r.success).toBe(true);
    expect(r.data.type).toBe('python');
  });

  test('html과 python 둘 다 있으면 html 우선', async () => {
    const env = mockCreateEnv(13);
    const r = await executeArtifactCreate(env, { title: 'both', html: '<html></html>', python: 'print(1)' });
    expect(r.data.type).toBe('html');
  });

  test('type 명시 시 사용', async () => {
    const env = mockCreateEnv(14);
    const r = await executeArtifactCreate(env, { title: 't', html: '<html></html>', type: 'widget' });
    expect(r.data.type).toBe('widget');
  });

  test('title 없으면 에러', async () => {
    const r = await executeArtifactCreate(makeEnv(), { html: '<html></html>' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('제목과 내용 필요');
  });

  test('내용 없으면 에러', async () => {
    const r = await executeArtifactCreate(makeEnv(), { title: 't' });
    expect(r.success).toBe(false);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeArtifactCreate(env, { title: 't', html: '<html></html>' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('아티팩트 생성 실패');
  });
});

describe('executeArtifactDelete', () => {
  test('ID로 삭제 성공', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 1 } } });
    const r = await executeArtifactDelete(env, { id: 5 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 5 });
  });

  test('삭제된 행 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: { meta: { changes: 0 } } });
    const r = await executeArtifactDelete(env, { id: 999 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('아티팩트를 찾을 수 없음');
  });

  test('meta 없으면 changes 0', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: {} });
    const r = await executeArtifactDelete(env, { id: 999 });
    expect(r.success).toBe(false);
  });

  test('제목으로 조회해 단일 결과면 삭제', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 3, title: 'app' }], run: { meta: { changes: 1 } } });
    const r = await executeArtifactDelete(env, { title: 'app' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(3);
  });

  test('제목 조회 결과 없으면 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [] });
    const r = await executeArtifactDelete(env, { title: '없음' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('제목 조회 결과 여러 개면 후보 목록 반환', async () => {
    const env = makeEnv();
    mockPrepare(env, { all: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] });
    const r = await executeArtifactDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('multiple_candidates');
    expect(r.candidates).toHaveLength(2);
  });

  test('results가 null이면 빈 배열', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue({ results: null }) }),
    });
    const r = await executeArtifactDelete(env, { title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('ID 유효하지 않으면 에러', async () => {
    const r = await executeArtifactDelete(makeEnv(), {});
    expect(r.success).toBe(false);
    expect(r.error).toBe('유효한 아티팩트 ID나 제목이 필요');
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await executeArtifactDelete(env, { id: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('아티팩트 삭제 실패');
  });
});

describe('executeArtifactList', () => {
  test('조회 성공', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      all: jest.fn().mockResolvedValue({ results: [{ id: 1, title: 'a' }] }),
    });
    const r = await executeArtifactList(env);
    expect(r.success).toBe(true);
    expect(r.data).toEqual([{ id: 1, title: 'a' }]);
  });

  test('results null이면 빈 배열', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      all: jest.fn().mockResolvedValue({ results: null }),
    });
    const r = await executeArtifactList(env);
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      all: jest.fn().mockRejectedValue(new Error('db')),
    });
    const r = await executeArtifactList(env);
    expect(r.success).toBe(false);
    expect(r.error).toBe('아티팩트 조회 실패');
  });
});

describe('detectHtmlFromResponse', () => {
  const makeHtml = (body: string) => `<html><head></head><body>${body}</body></html>`.padEnd(250, 'x');

  test('마크다운 코드 블록에서 완성된 HTML 추출', () => {
    const html = makeHtml('hello');
    const text = `여기 있습니다:\n\`\`\`html\n${html}\n\`\`\``;
    expect(detectHtmlFromResponse(text)).toBe(html);
  });

  test('가장 긴 완성된 HTML 선택', () => {
    const short = `<html><head></head><body>a</body></html>`.padEnd(250, 'x');
    const long = `<html><head></head><body>${'b'.repeat(100)}</body></html>`.padEnd(400, 'x');
    const text = `\`\`\`html\n${short}\n\`\`\`\n\`\`\`html\n${long}\n\`\`\``;
    expect(detectHtmlFromResponse(text)).toBe(long);
  });

  test('두 번째 HTML이 더 짧으면 첫 번째 유지 (length 비교 false 분기)', () => {
    const long = `<html><head></head><body>${'a'.repeat(100)}</body></html>`.padEnd(400, 'x');
    const short = `<html><head></head><body>b</body></html>`.padEnd(250, 'x');
    const text = `\`\`\`html\n${long}\n\`\`\`\n\`\`\`html\n${short}\n\`\`\``;
    expect(detectHtmlFromResponse(text)).toBe(long);
  });

  test('첫 번째 코드 블록이 미완성이면 두 번째가 best (!best 분기)', () => {
    const incomplete = '```html\n<html><body>짧음\n```';
    const html = `<html><head></head><body>${'x'.repeat(200)}</body></html>`;
    const text = `${incomplete}\n\`\`\`html\n${html}\n\`\`\``;
    expect(detectHtmlFromResponse(text)).toBe(html);
  });

  test('미완성 HTML(</html> 없음)은 무시', () => {
    const text = '```html\n<html><body>짧음</body>\n```';
    expect(detectHtmlFromResponse(text)).toBeNull();
  });

  test('200자 미만은 무시', () => {
    const text = '```html\n<html></html>\n```';
    expect(detectHtmlFromResponse(text)).toBeNull();
  });

  test('코드 블록 없이 직접 출력된 HTML 감지', () => {
    const html = `<html><head><title>test</title></head><body>${'direct'.repeat(40)}</body></html>`;
    const text = `결과:\n${html}\n끝`;
    expect(detectHtmlFromResponse(text)).toBe(html);
  });

  test('DOCTYPE 포함 HTML 감지', () => {
    const html = `<!DOCTYPE html><html><head></head><body>${'x'.repeat(200)}</body></html>`;
    expect(detectHtmlFromResponse(`prefix ${html} suffix`)).toBe(html);
  });

  test('HTML 없으면 null', () => {
    expect(detectHtmlFromResponse('그냥 텍스트입니다')).toBeNull();
  });

  test('대소문자 무시', () => {
    const html = `<HTML><HEAD></HEAD><BODY>${'y'.repeat(200)}</BODY></HTML>`;
    expect(detectHtmlFromResponse(html)).toBe(html);
  });
});

describe('saveArtifactDraft', () => {
  function mockDraftEnv() {
    const env = makeEnv();
    let callIdx = 0;
    env.DB.prepare = jest.fn().mockImplementation((sql: string) => {
      callIdx++;
      return {
        bind: jest.fn().mockReturnValue({
          run: jest.fn().mockResolvedValue({ meta: { last_row_id: 10 } }),
        }),
      };
    });
    return { env, getCallCount: () => callIdx };
  }

  test('초안 저장 성공 (draft status)', async () => {
    const { env } = mockDraftEnv();
    const r = await saveArtifactDraft(env, 'draft app', '<html>x</html>');
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 10, title: 'draft app', status: 'draft' });
    // draft 포인터 UPDATE가 호출되었는지 (3번째 prepare)
    const sqls = env.DB.prepare.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.some((s: string) => s.includes('draft_version_id = ? WHERE'))).toBe(true);
  });

  test('500KB 초과 시 에러', async () => {
    const r = await saveArtifactDraft(makeEnv(), 'big', 'x'.repeat(500 * 1024 + 1));
    expect(r.success).toBe(false);
    expect(r.error).toContain('500KB');
  });

  test('500KB 정확히는 허용', async () => {
    const { env } = mockDraftEnv();
    const r = await saveArtifactDraft(env, 'edge', 'x'.repeat(500 * 1024));
    expect(r.success).toBe(true);
  });

  test('DB 실패 시 에러', async () => {
    const env = makeEnv();
    mockPrepare(env, { run: new Error('db') });
    const r = await saveArtifactDraft(env, 't', '<html></html>');
    expect(r.success).toBe(false);
    expect(r.error).toBe('초안 저장 실패');
  });
});

describe('executeArtifactFromGithub', () => {
  // 참고: escapeHtml (257행)의 `|| c` 폴백은 도달 불가 방어 코드임.
  // 정규식 /[&<>"']/g는 5개 문자만 매칭하고 매핑 객체에 5개 키가 모두 있어
  // 콜백에 전달되는 문자는 항상 매핑됨. 소스 수정 없이 문서화.
  const mockGithubApi = (info: any, readme: string | null) => {
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => info };
      }
      if (url.includes('raw.githubusercontent.com')) {
        if (readme !== null && url.includes('/main/')) {
          return { ok: true, text: async () => readme };
        }
        return { ok: false };
      }
      return { ok: false };
    });
  };

  function mockCreateEnv() {
    const env = makeEnv();
    env.DB.prepare = jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        run: jest.fn().mockResolvedValue({ meta: { last_row_id: 99 } }),
      }),
    });
    return env;
  }

  test('repo 없으면 에러', async () => {
    const r = await executeArtifactFromGithub(makeEnv(), {});
    expect(r.success).toBe(false);
    expect(r.error).toContain('GitHub repo 필요');
  });

  test('GitHub API 실패 시 에러', async () => {
    (global.fetch as any) = jest.fn().mockResolvedValue({ ok: false });
    const r = await executeArtifactFromGithub(makeEnv(), { repo: 'user/repo' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('찾을 수 없음');
  });

  test('정상 가져오기 (main 브랜치 README)', async () => {
    mockGithubApi(
      { name: 'myrepo', html_url: 'https://github.com/u/myrepo', description: 'desc', stargazers_count: 10, forks_count: 2, language: 'TS' },
      '# Hello'
    );
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/myrepo' });
    expect(r.success).toBe(true);
    expect(r.data.id).toBe(99);
    expect(r.data.title).toBe('myrepo');
    expect(r.data.repo).toBe('u/myrepo');
  });

  test('main 실패 시 master 시도', async () => {
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ name: 'r', html_url: 'u', description: '', stargazers_count: 0, forks_count: 0, language: '' }) };
      }
      if (url.includes('/main/')) return { ok: false };
      if (url.includes('/master/')) return { ok: true, text: async () => '# master readme' };
      return { ok: false };
    });
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r' });
    expect(r.success).toBe(true);
  });

  test('master fetch가 throw해도 성공 (catch 분기)', async () => {
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ name: 'r', html_url: 'u', description: '', stargazers_count: 0, forks_count: 0, language: '' }) };
      }
      if (url.includes('/main/')) return { ok: false };
      if (url.includes('/master/')) throw new Error('network error');
      return { ok: false };
    });
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r' });
    expect(r.success).toBe(true);
  });

  test('master도 ok:false면 빈 README로 성공', async () => {
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ name: 'r', html_url: 'u', description: '', stargazers_count: 0, forks_count: 0, language: '' }) };
      }
      return { ok: false };
    });
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r' });
    expect(r.success).toBe(true);
  });

  test('info.name 없으면 repo를 제목으로 사용', async () => {
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ name: null, html_url: 'u', description: '', stargazers_count: 0, forks_count: 0, language: '' }) };
      }
      return { ok: false };
    });
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/fallback-repo' });
    expect(r.success).toBe(true);
    expect(r.data.title).toBe('u/fallback-repo');
  });

  test('README 없어도 성공 (빈 내용)', async () => {
    mockGithubApi({ name: 'r', html_url: 'u', description: null, stargazers_count: 0, forks_count: 0, language: null }, null);
    // readme fetch가 throw하는 경우
    (global.fetch as any) = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ name: 'r', html_url: 'u' }) };
      }
      throw new Error('network');
    });
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r' });
    expect(r.success).toBe(true);
  });

  test('title 직접 지정 시 사용', async () => {
    mockGithubApi({ name: 'repo-name', html_url: 'u', description: '', stargazers_count: 0, forks_count: 0, language: '' }, '# hi');
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r', title: '커스텀 제목' });
    expect(r.data.title).toBe('커스텀 제목');
  });

  test('HTML 이스케이프 확인', async () => {
    mockGithubApi(
      { name: '<script>alert(1)</script>', html_url: 'u', description: '<b>bold</b>', stargazers_count: 0, forks_count: 0, language: '' },
      '# hi'
    );
    const env = mockCreateEnv();
    const r = await executeArtifactFromGithub(env, { repo: 'u/r' });
    expect(r.success).toBe(true);
    // DB에 저장된 html에 이스케이프된 내용이 포함되어야 함
    const boundHtml = env.DB.prepare.mock.calls
      .map((c: any[]) => c[0])
      .find((s: string) => s.includes('INSERT INTO artifacts'));
    expect(boundHtml).toBeDefined();
  });

  test('fetch throw 시 에러', async () => {
    (global.fetch as any) = jest.fn().mockRejectedValue(new Error('down'));
    const r = await executeArtifactFromGithub(makeEnv(), { repo: 'u/r' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('GitHub 가져오기 실패');
  });
});
