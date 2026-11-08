/// <reference types="jest" />
/**
 * src/services/tools.ts 테스트
 * 도구 레지스트리 (registerTool / getToolDefinitions / executeTool)
 */

import { registerTool, getToolDefinitions, executeTool } from '../../src/services/tools';

describe('registerTool / getToolDefinitions', () => {
  test('도구를 등록하면 getToolDefinitions에 포함된다', () => {
    const def = {
      name: 'svc3-test-echo',
      description: 'echo tool',
      parameters: {
        type: 'object' as const,
        properties: { msg: { type: 'string', description: 'message' } },
        required: ['msg'],
      },
    };
    registerTool(def, async () => ({ ok: true, data: 'x' }));
    const defs = getToolDefinitions();
    expect(defs.find((d) => d.name === 'svc3-test-echo')).toEqual(def);
  });

  test('같은 이름으로 재등록하면 덮어쓴다', () => {
    const def1 = {
      name: 'svc3-test-overwrite',
      description: 'v1',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    };
    const def2 = {
      name: 'svc3-test-overwrite',
      description: 'v2',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    };
    registerTool(def1, async () => ({ ok: true }));
    registerTool(def2, async () => ({ ok: false }));
    const found = getToolDefinitions().filter((d) => d.name === 'svc3-test-overwrite');
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe('v2');
  });
});

describe('executeTool', () => {
  test('등록된 도구를 실행하고 결과를 반환한다', async () => {
    registerTool(
      {
        name: 'svc3-exec-success',
        description: 'success',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      async (args) => ({ ok: true, data: { echo: args } })
    );
    const result = await executeTool('svc3-exec-success', { a: 1 });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ echo: { a: 1 } });
  });

  test('미등록 도구는 Unknown tool 에러를 반환한다', async () => {
    const result = await executeTool('svc3-no-such-tool-xyz', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown tool');
    expect(result.error).toContain('svc3-no-such-tool-xyz');
  });

  test('핸들러가 throw하면 ok:false와 에러 메시지를 반환한다', async () => {
    registerTool(
      {
        name: 'svc3-exec-throw',
        description: 'throw',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      async () => {
        throw new Error('boom');
      }
    );
    const result = await executeTool('svc3-exec-throw', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  test('핸들러 에러 메시지는 200자로 잘린다', async () => {
    registerTool(
      {
        name: 'svc3-exec-long-error',
        description: 'long error',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      async () => {
        throw new Error('x'.repeat(500));
      }
    );
    const result = await executeTool('svc3-exec-long-error', {});
    expect(result.ok).toBe(false);
    expect(result.error!.length).toBeLessThanOrEqual(200);
  });

  test('비-Error throw도 문자열로 변환된다', async () => {
    registerTool(
      {
        name: 'svc3-exec-throw-string',
        description: 'throw string',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      async () => {
        throw 'plain string error';
      }
    );
    const result = await executeTool('svc3-exec-throw-string', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('plain string error');
  });
});
