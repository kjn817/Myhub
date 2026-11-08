/// <reference types="jest" />
import { z } from 'zod'
import { ToolRegistry, toJsonSchema } from '../../src/ai/tools/registry'
import type { ToolDefinition, ToolCall, ExecutionContext } from '../../src/ai/types'

const ENV = { DB: {} as D1Database }

function makeDef(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    mode: 'read',
  }
}

const testSchema = z.object({ query: z.string().min(1) })

const testExecutor = async (args: unknown) => ({ echo: args })

function makeCtx(): ExecutionContext {
  return { userId: 'u1', requestId: 'r1', approvedWrites: false }
}

function makeCall(name: string, args: unknown): ToolCall {
  return { id: 'call-1', name, args, provider: 'gemini' as const }
}

describe('ToolRegistry.register/get', () => {
  test('registers and retrieves a tool', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('search_memo'), testSchema, testExecutor)
    expect(reg.get('search_memo')).toBeDefined()
  })

  test('get returns undefined for unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  test('duplicate registration throws', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('search_memo'), testSchema, testExecutor)
    expect(() => reg.register(makeDef('search_memo'), testSchema, testExecutor)).toThrow(
      'Tool already registered: search_memo'
    )
  })
})

describe('ToolRegistry.list', () => {
  test('lists all registered definitions', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('a'), testSchema, testExecutor)
    reg.register(makeDef('b'), testSchema, testExecutor)
    const list = reg.list()
    expect(list.length).toBe(2)
    expect(list.map((d) => d.name).sort()).toEqual(['a', 'b'])
  })

  test('list with filter returns only matching', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('a'), testSchema, testExecutor)
    reg.register(makeDef('b'), testSchema, testExecutor)
    const list = reg.list(['a'])
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('a')
  })

  test('list with empty filter returns empty', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('a'), testSchema, testExecutor)
    expect(reg.list([])).toEqual([])
  })

  test('list definitions exclude executor/schema', () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('a'), testSchema, testExecutor)
    const list = reg.list()
    expect(list[0]).toEqual(makeDef('a'))
    expect('executor' in list[0]).toBe(false)
    expect('schema' in list[0]).toBe(false)
  })
})

describe('ToolRegistry.execute', () => {
  test('executes successfully with valid args', async () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('search_memo'), testSchema, testExecutor)
    const result = await reg.execute(makeCall('search_memo', { query: 'hello' }), makeCtx(), ENV)
    expect(result.callId).toBe('call-1')
    expect(result.name).toBe('search_memo')
    expect(result.output).toEqual({ ok: true, data: { echo: { query: 'hello' } } })
  })

  test('returns UNKNOWN_TOOL for unregistered tool', async () => {
    const reg = new ToolRegistry()
    const result = await reg.execute(makeCall('nope', {}), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: 'Unknown tool: nope',
    })
  })

  test('returns INVALID_ARGUMENTS when zod fails', async () => {
    const reg = new ToolRegistry()
    reg.register(makeDef('search_memo'), testSchema, testExecutor)
    const result = await reg.execute(makeCall('search_memo', { query: '' }), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'INVALID_ARGUMENTS',
      message: 'Invalid arguments',
    })
  })

  test('returns INTERNAL_ERROR when result too large', async () => {
    const reg = new ToolRegistry()
    const bigExecutor = async () => 'x'.repeat(20000)
    reg.register(makeDef('big'), testSchema, bigExecutor)
    const result = await reg.execute(makeCall('big', { query: 'q' }), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Result too large',
    })
  })

  test('maps executor timeout error', async () => {
    const reg = new ToolRegistry()
    const slowExecutor = async () => {
      await new Promise((r) => setTimeout(r, 100))
      return 'done'
    }
    reg.register(makeDef('slow'), testSchema, slowExecutor)
    const result = await reg.execute(makeCall('slow', { query: 'q' }), makeCtx(), ENV, 10)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'TIMEOUT',
      message: 'Tool execution timed out',
    })
  })

  test('maps ACCESS_DENIED error', async () => {
    const reg = new ToolRegistry()
    const denyExecutor = async () => {
      throw new Error('ACCESS_DENIED: no permission')
    }
    reg.register(makeDef('deny'), testSchema, denyExecutor)
    const result = await reg.execute(makeCall('deny', { query: 'q' }), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'ACCESS_DENIED',
      message: 'Access denied',
    })
  })

  test('maps D1 error to DB_ERROR without leaking SQL', async () => {
    const reg = new ToolRegistry()
    const dbExecutor = async () => {
      throw new Error('D1_ERROR: SELECT * FROM secrets_table WHERE ...')
    }
    reg.register(makeDef('db'), testSchema, dbExecutor)
    const result = await reg.execute(makeCall('db', { query: 'q' }), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'DB_ERROR',
      message: 'Database error',
    })
  })

  test('maps database error message to DB_ERROR', async () => {
    const reg = new ToolRegistry()
    const dbExecutor = async () => {
      throw new Error('database connection failed')
    }
    reg.register(makeDef('db2'), testSchema, dbExecutor)
    const result = await reg.execute(makeCall('db2', { query: 'q' }), makeCtx(), ENV)
    expect(result.output.errorCode).toBe('DB_ERROR')
  })

  test('maps SQL error message to DB_ERROR', async () => {
    const reg = new ToolRegistry()
    const dbExecutor = async () => {
      throw new Error('SQL syntax error near ...')
    }
    reg.register(makeDef('db3'), testSchema, dbExecutor)
    const result = await reg.execute(makeCall('db3', { query: 'q' }), makeCtx(), ENV)
    expect(result.output.errorCode).toBe('DB_ERROR')
  })

  test('maps unknown error to INTERNAL_ERROR', async () => {
    const reg = new ToolRegistry()
    const boomExecutor = async () => {
      throw new Error('something weird')
    }
    reg.register(makeDef('boom'), testSchema, boomExecutor)
    const result = await reg.execute(makeCall('boom', { query: 'q' }), makeCtx(), ENV)
    expect(result.output).toEqual({
      ok: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal error',
    })
  })

  test('handles non-Error throws', async () => {
    const reg = new ToolRegistry()
    const throwExecutor = async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string error'
    }
    reg.register(makeDef('str'), testSchema, throwExecutor)
    const result = await reg.execute(makeCall('str', { query: 'q' }), makeCtx(), ENV)
    expect(result.output.errorCode).toBe('INTERNAL_ERROR')
  })

  test('timeout clears when executor resolves in time', async () => {
    const reg = new ToolRegistry()
    const fastExecutor = async () => 'fast'
    reg.register(makeDef('fast'), testSchema, fastExecutor)
    const result = await reg.execute(makeCall('fast', { query: 'q' }), makeCtx(), ENV, 1000)
    expect(result.output).toEqual({ ok: true, data: 'fast' })
  })

  test('timeout clears when executor rejects in time', async () => {
    const reg = new ToolRegistry()
    const failFast = async () => {
      throw new Error('ACCESS_DENIED fast')
    }
    reg.register(makeDef('failfast'), testSchema, failFast)
    const result = await reg.execute(makeCall('failfast', { query: 'q' }), makeCtx(), ENV, 1000)
    expect(result.output.errorCode).toBe('ACCESS_DENIED')
  })
})

describe('toJsonSchema', () => {
  test('converts zod schema to JSON schema', () => {
    const out = toJsonSchema(testSchema)
    expect(typeof out).toBe('object')
    expect(out.type).toBe('object')
  })

  test('preserves required fields', () => {
    const out = toJsonSchema(testSchema) as any
    expect(out.required).toContain('query')
  })
})
