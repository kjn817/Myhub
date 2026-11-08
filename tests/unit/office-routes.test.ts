/// <reference types="jest" />
/**
 * src/modules/ai/office-routes.ts — 오피스 비서 라우트 성질 테스트.
 *
 * 고정하는 성질 (실제 Hono 앱 + 로컬 D1):
 * - 입력 경계: 알 수 없는 앱·빈 지시·잘못된 id는 400, 없는 메모는
 *   404 memo_not_found, 모델 실패는 502 ai_failed로 구분되어 돌아온다.
 * - 메일 발송 승인: 초안 토큰 없이는 403(approval_required), 초안을
 *   바꾸면 403(approval_mismatch), 일치하면 다음 게이트(쓰기 비활성
 *   403 write_disabled)까지 진행한다 — 발송 자체는 우회되지 않는다.
 * - 정리 적용: plan에서 발급된 토큰이 있어야만 DB의 파일명·폴더가
 *   실제로 바뀌고, 변조된 항목은 제외된다. 토큰은 해시 키 없이 만들 수 없다.
 * 카나리아: 승인 서명 검증을 깨면 발송·적용 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createOfficeAiApp } from '../../src/modules/ai/office-routes'
import { signApproval } from '../../src/services/office-ops'
import type { OfficeChatFn } from '../../src/services/office-ai'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')
const SECRET = 'route-test-secret'

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0001_init.sql'))
  db.exec(
    'ALTER TABLE memos ADD COLUMN is_locked INTEGER DEFAULT 0; ' +
      'ALTER TABLE memos ADD COLUMN sensitivity INTEGER DEFAULT 1; ' +
      "ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]'; " +
      'ALTER TABLE memos ADD COLUMN title_hint TEXT;',
  )
  db.exec(mig('0067_drive_storage.sql'))
  db.exec(mig('0030_fts_d1_compat.sql'))
  db.exec(mig('0059_memo_fts_trigram.sql'))
  return db
}

async function seedMemo(db: any, text: string, isLocked = 0, sensitivity = 1): Promise<number> {
  const r = await db
    .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
    .bind(text, isLocked, sensitivity)
    .run()
  return Number(r.meta.last_row_id)
}

interface SeededFile {
  id: number
  filename: string
  folderId: number | null
}

async function seedFile(
  db: any,
  filename: string,
  folderId: number | null = null,
  opts: { deleted?: boolean } = {},
): Promise<SeededFile> {
  const r = await db
    .prepare(
      'INSERT INTO drive_files (filename, folder_id, mime, size, storage_key, url, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(filename, folderId, 'application/octet-stream', 10, `key/${filename}`, `https://files.example/${filename}`, opts.deleted ? '2026-01-01T00:00:00Z' : null)
    .run()
  return { id: Number(r.meta.last_row_id), filename, folderId }
}

interface Call {
  messages: Array<{ role: string; content: string }>
}

function makeApp(chatText: string | ((call: Call) => string)) {
  const calls: Call[] = []
  const chat: OfficeChatFn = async (_env, _policy, messages) => {
    const call: Call = { messages: messages as Call['messages'] }
    calls.push(call)
    return { text: typeof chatText === 'function' ? chatText(call) : chatText }
  }
  const app = createOfficeAiApp({ chat })
  return { app, calls }
}

function envOf(db: any, extra: Record<string, unknown> = {}) {
  return { DB: db, SESSION_SECRET: SECRET, ...extra } as never
}

async function post(app: ReturnType<typeof createOfficeAiApp>, env: never, routePath: string, body: unknown) {
  const res = await app.request(
    routePath,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

describe('/instruct — 입력 경계와 응답', () => {
  test('알 수 없는 앱은 400 bad app, 빈 지시는 400 instruction_required', async () => {
    const db = makeDb()
    const { app } = makeApp('네.')
    const badApp = await post(app, envOf(db), '/instruct', { app: 'word', instruction: '해줘' })
    expect(badApp.status).toBe(400)
    expect(badApp.json.error).toContain('bad app')
    const empty = await post(app, envOf(db), '/instruct', { app: 'excel', instruction: '  ' })
    expect(empty.status).toBe(400)
    expect(empty.json.error).toBe('instruction_required')
  })

  test('정상: reply와 ops가 JSON으로 돌아오고 fileName은 200자로 잘려 전달된다', async () => {
    const db = makeDb()
    const { app, calls } = makeApp('적용했어요.\n[OFFICE_OPS]{"ops":[{"type":"set_cell","cell":"A1","value":1}]}[/OFFICE_OPS]')
    const longName = '파일'.repeat(150)
    const r = await post(app, envOf(db), '/instruct', { app: 'excel', instruction: 'A1에 1', fileName: longName })
    expect(r.status).toBe(200)
    expect(r.json.reply).toBe('적용했어요.')
    expect(r.json.ops).toEqual([{ type: 'set_cell', cell: 'A1', value: 1 }])
    expect(r.json.findings).toEqual([])
    const fileLine = calls[0].messages[1].content.split('\n')[0]
    expect(fileLine).toBe(`파일: ${'파일'.repeat(100)}`)
  })

  test('모델이 던지면 502 ai_failed', async () => {
    const db = makeDb()
    const app = createOfficeAiApp({
      chat: (async () => {
        throw new Error('provider down')
      }) as never,
    })
    const r = await post(app, envOf(db), '/instruct', { app: 'excel', instruction: '해줘' })
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('ai_failed')
  })
})

describe('/memos — 검색 라우트', () => {
  test('q로 검색해 접근 가능한 메모만 돌려준다', async () => {
    const db = makeDb()
    const openId = await seedMemo(db, '분기 실적 제목\n내용')
    await seedMemo(db, '분기 실적 다른 메모\n잠긴 것', 1, 1)
    const res = await app0(db).request('/memos?q=' + encodeURIComponent('분기'), undefined, envOf(db))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.memos.map((m: { id: number }) => m.id)).toEqual([openId])
  })
})

function app0(db: any) {
  void db
  return createOfficeAiApp({ chat: (async () => ({ text: '' })) as never })
}

describe('/from-memo — 계획 라우트', () => {
  const MODEL = '[OFFICE_DOC]{"title":"계획 문서","paragraphs":["문단"],"table":null}[/OFFICE_DOC]'

  test('memoId가 숫자가 아니거나 target이 틀리면 400 bad input', async () => {
    const db = makeDb()
    const { app } = makeApp(MODEL)
    for (const body of [
      { memoId: 'abc', target: 'excel' },
      { memoId: 0, target: 'excel' },
      { memoId: -3, target: 'excel' },
      { memoId: 1, target: 'pdf' },
    ]) {
      const r = await post(app, envOf(db), '/from-memo', body)
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('bad input')
    }
  })

  test('없는 메모는 404, 잠긴 메모도 404로 숨겨진다', async () => {
    const db = makeDb()
    const locked = await seedMemo(db, '잠긴 메모', 1, 1)
    const { app } = makeApp(MODEL)
    const missing = await post(app, envOf(db), '/from-memo', { memoId: 999, target: 'excel' })
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe('memo_not_found')
    const hidden = await post(app, envOf(db), '/from-memo', { memoId: locked, target: 'hangul' })
    expect(hidden.status).toBe(404)
  })

  test('정상: 계획 ops와 제목이 돌아온다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '계획의 원본 메모')
    const { app } = makeApp(MODEL)
    const r = await post(app, envOf(db), '/from-memo', { memoId, target: 'excel' })
    expect(r.status).toBe(200)
    expect(r.json.title).toBe('계획 문서')
    expect(r.json.ops.length).toBeGreaterThan(0)
  })

  test('/from-memo-doc: 마크다운 계획이 돌아온다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '문서화할 메모')
    const { app } = makeApp(MODEL)
    const r = await post(app, envOf(db), '/from-memo-doc', { memoId })
    expect(r.status).toBe(200)
    expect(r.json.markdown).toContain('# 계획 문서')
    const bad = await post(app, envOf(db), '/from-memo-doc', { memoId: 'x' })
    expect(bad.status).toBe(400)
  })
})

describe('/mail/draft · /mail/send — 승인 경계', () => {
  const DRAFT = '[MAIL_DRAFT]{"subject":"자료 송부","body":"요청하신 자료를 보냅니다."}[/MAIL_DRAFT]'

  test('draft: 없는 파일·삭제된 파일은 404 file_not_found', async () => {
    const db = makeDb()
    const deleted = await seedFile(db, '지운파일.xlsx', null, { deleted: true })
    const { app } = makeApp(DRAFT)
    const missing = await post(app, envOf(db), '/mail/draft', { to: 'a@b.co', fileId: 999 })
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe('file_not_found')
    const gone = await post(app, envOf(db), '/mail/draft', { to: 'a@b.co', fileId: deleted.id })
    expect(gone.status).toBe(404)
  })

  test('draft: 잘못된 수신자는 400 bad_recipient', async () => {
    const db = makeDb()
    const { app } = makeApp(DRAFT)
    const r = await post(app, envOf(db), '/mail/draft', { to: 'nope', fileName: 'a.xlsx' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('bad_recipient')
  })

  test('draft: fileId를 주면 DB의 파일명이 초안 작성에 쓰이고 토큰이 함께 온다', async () => {
    const db = makeDb()
    const file = await seedFile(db, '분기보고서.xlsx')
    const { app, calls } = makeApp(DRAFT)
    const r = await post(app, envOf(db), '/mail/draft', { to: 'a@b.co', fileId: file.id })
    expect(r.status).toBe(200)
    expect(r.json.draft).toEqual({ to: 'a@b.co', subject: '자료 송부', body: '요청하신 자료를 보냅니다.' })
    expect(typeof r.json.token).toBe('string')
    expect(r.json.token.length).toBeGreaterThan(10)
    expect(calls[0].messages[1].content).toContain('첨부 문서: 분기보고서.xlsx')
  })

  test('send: confirm이나 token이 없으면 403 approval_required', async () => {
    const db = makeDb()
    const { app } = makeApp(DRAFT)
    const draft = { to: 'a@b.co', subject: '제목', body: '본문' }
    const noConfirm = await post(app, envOf(db), '/mail/send', { draft, token: 'x' })
    expect(noConfirm.status).toBe(403)
    expect(noConfirm.json.error).toBe('approval_required')
    const noToken = await post(app, envOf(db), '/mail/send', { draft, confirm: true })
    expect(noToken.status).toBe(403)
    expect(noToken.json.error).toBe('approval_required')
  })

  test('send: 초안을 한 글자라도 바꾸면 403 approval_mismatch', async () => {
    const db = makeDb()
    const { app } = makeApp(DRAFT)
    const drafted = await post(app, envOf(db), '/mail/draft', { to: 'a@b.co' })
    const tampered = { ...drafted.json.draft, body: drafted.json.draft.body + ' (변조)' }
    const r = await post(app, envOf(db), '/mail/send', { draft: tampered, token: drafted.json.token, confirm: true })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('approval_mismatch')
  })

  test('send: 승인된 초안이라도 빈 본문이면 400 invalid_input', async () => {
    const db = makeDb()
    const { app } = makeApp(DRAFT)
    const emptyDraft = { to: 'a@b.co', subject: '제목만 있음', body: '' }
    const token = await signApproval(SECRET, { draft: emptyDraft, fileId: null })
    const r = await post(app, envOf(db), '/mail/send', { draft: emptyDraft, token, confirm: true })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('invalid_input')
  })

  test('send: 승인이 일치하면 쓰기 게이트(미활성)에서 403 write_disabled로 막힌다', async () => {
    const db = makeDb()
    const { app } = makeApp(DRAFT)
    const drafted = await post(app, envOf(db), '/mail/draft', { to: 'a@b.co' })
    const r = await post(app, envOf(db), '/mail/send', { draft: drafted.json.draft, token: drafted.json.token, confirm: true })
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('write_disabled')
  })

  test('send: fileId를 줬는데 파일의 url이 없으면 404 file_not_found', async () => {
    const db = makeDb()
    const r0 = await db
      .prepare(
        'INSERT INTO drive_files (filename, folder_id, mime, size, storage_key, url) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('주소없는파일.xlsx', null, 'application/octet-stream', 1, 'key/nourl', null)
      .run()
    const fileId = Number(r0.meta.last_row_id)
    const { app } = makeApp(DRAFT)
    const draft = { to: 'a@b.co', subject: '제목', body: '본문' }
    const token = await signApproval(SECRET, { draft, fileId })
    const r = await post(app, envOf(db, { GOOGLE_WRITE_ENABLED: 'true' }), '/mail/send', {
      draft,
      token,
      confirm: true,
      fileId,
    })
    expect(r.status).toBe(404)
    expect(r.json.error).toBe('file_not_found')
  })
})

describe('/organize/plan · /organize/apply — 정리 종단', () => {
  test('plan: folderId가 정수가 아니거나 음수·소수면 400 bad folder', async () => {
    const db = makeDb()
    const { app } = makeApp('[OFFICE_PLAN]{"plan":[]}[/OFFICE_PLAN]')
    for (const folderId of ['abc', -2, 1.5]) {
      const r = await post(app, envOf(db), '/organize/plan', { folderId })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('bad folder')
    }
  })

  test('plan→apply: 발급된 토큰으로 실제 파일명이 바뀌고 폴더가 이동한다', async () => {
    const db = makeDb()
    const folderId = Number(
      (await db.prepare('INSERT INTO drive_folders (name) VALUES (?)').bind('업무').run()).meta.last_row_id,
    )
    const a = await seedFile(db, '원본이름.xlsx')
    const b = await seedFile(db, '이동대상.png')
    const planJson = `[OFFICE_PLAN]${JSON.stringify({
      plan: [
        { fileId: a.id, newName: '새이름.xlsx' },
        { fileId: b.id, toFolderId: folderId },
      ],
    })}[/OFFICE_PLAN]`
    const { app, calls } = makeApp(planJson)
    const planned = await post(app, envOf(db), '/organize/plan', {})
    expect(planned.status).toBe(200)
    expect(planned.json.plan.length).toBe(2)
    expect(planned.json.plan.every((p: { token?: string }) => typeof p.token === 'string')).toBe(true)
    // 모델에게는 폴더 체계와 파일 목록이 전달된다
    expect(calls[0].messages[1].content).toContain('원본이름.xlsx')
    expect(calls[0].messages[1].content).toContain('업무')

    const applied = await post(app, envOf(db), '/organize/apply', { plan: planned.json.plan, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.json).toEqual({
      ok: true,
      applied: [
        { fileId: a.id, newName: '새이름.xlsx' },
        { fileId: b.id, toFolderId: folderId },
      ],
      errors: [],
    })
    const rowA = (await db.prepare('SELECT filename, folder_id FROM drive_files WHERE id = ?').bind(a.id).first()) as { filename: string; folder_id: number | null } | null
    const rowB = (await db.prepare('SELECT filename, folder_id FROM drive_files WHERE id = ?').bind(b.id).first()) as { filename: string; folder_id: number | null } | null
    expect(rowA?.filename).toBe('새이름.xlsx')
    expect(rowB?.folder_id).toBe(folderId)
  })

  test('plan: folderId를 주면 그 폴더의 파일만 모델에 보여 준다', async () => {
    const db = makeDb()
    const folderId = Number(
      (await db.prepare('INSERT INTO drive_folders (name) VALUES (?)').bind('폴더A').run()).meta.last_row_id,
    )
    await seedFile(db, '폴더안.xlsx', folderId)
    await seedFile(db, '루트파일.xlsx', null)
    const { app, calls } = makeApp('[OFFICE_PLAN]{"plan":[]}[/OFFICE_PLAN]')
    const r = await post(app, envOf(db), '/organize/plan', { folderId })
    expect(r.status).toBe(200)
    expect(calls[0].messages[1].content).toContain('폴더안.xlsx')
    expect(calls[0].messages[1].content).not.toContain('루트파일.xlsx')
  })

  test('apply: confirm이 없으면 403, 토큰 없는 항목뿐이면 403 approval_mismatch', async () => {
    const db = makeDb()
    const a = await seedFile(db, '대상.xlsx')
    const { app } = makeApp('[OFFICE_PLAN]{"plan":[]}[/OFFICE_PLAN]')
    const noConfirm = await post(app, envOf(db), '/organize/apply', { plan: [{ fileId: a.id, newName: 'x.xlsx' }] })
    expect(noConfirm.status).toBe(403)
    expect(noConfirm.json.error).toBe('approval_required')
    const tokenless = await post(app, envOf(db), '/organize/apply', {
      plan: [{ fileId: a.id, newName: 'x.xlsx' }],
      confirm: true,
    })
    expect(tokenless.status).toBe(403)
    expect(tokenless.json.error).toBe('approval_mismatch')
    // DB는 바뀌지 않았다
    const row = (await db.prepare('SELECT filename FROM drive_files WHERE id = ?').bind(a.id).first()) as { filename: string } | null
    expect(row?.filename).toBe('대상.xlsx')
  })

  test('apply: 항목을 변조하면 그 항목은 제외되고 나머지만 적용된다', async () => {
    const db = makeDb()
    const a = await seedFile(db, '첫째.xlsx')
    const b = await seedFile(db, '둘째.xlsx')
    const planJson = `[OFFICE_PLAN]${JSON.stringify({
      plan: [
        { fileId: a.id, newName: '바뀐첫째.xlsx' },
        { fileId: b.id, newName: '바뀐둘째.xlsx' },
      ],
    })}[/OFFICE_PLAN]`
    const { app } = makeApp(planJson)
    const planned = await post(app, envOf(db), '/organize/plan', {})
    const tamperedPlan = planned.json.plan.map((p: any, i: number) => (i === 1 ? { ...p, newName: '변조된이름.xlsx' } : p))
    const applied = await post(app, envOf(db), '/organize/apply', { plan: tamperedPlan, confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.json.applied.length).toBe(1)
    expect(applied.json.applied[0].fileId).toBe(a.id)
    // 검증에 실패한 항목은 오류 목록이 아니라 조용히 제외된다 (적용 대상에서 빠짐)
    expect(applied.json.errors).toEqual([])
    const rowB = (await db.prepare('SELECT filename FROM drive_files WHERE id = ?').bind(b.id).first()) as { filename: string } | null
    expect(rowB?.filename).toBe('둘째.xlsx')
  })

  test('apply: 서명은 맞지만 대상이 사라진 항목은 ok:true와 함께 오류로 보고된다', async () => {
    const db = makeDb()
    const { app } = makeApp('[OFFICE_PLAN]{"plan":[]}[/OFFICE_PLAN]')
    const item = { fileId: 999, newName: '유령.xlsx' }
    const token = await signApproval(SECRET, { folderId: null, entry: item })
    const r = await post(app, envOf(db), '/organize/apply', { plan: [{ ...item, token }], confirm: true })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.applied).toEqual([])
    expect(r.json.errors).toEqual(['파일 999를 찾을 수 없음'])
  })

  test('apply: 없는 폴더로의 이동은 오류로 보고되고 파일은 제자리에 남는다', async () => {
    const db = makeDb()
    const a = await seedFile(db, '고정.png')
    const { app } = makeApp('[OFFICE_PLAN]{"plan":[]}[/OFFICE_PLAN]')
    const item = { fileId: a.id, toFolderId: 999 }
    const token = await signApproval(SECRET, { folderId: null, entry: item })
    const r = await post(app, envOf(db), '/organize/apply', { plan: [{ ...item, token }], confirm: true })
    expect(r.json.errors).toEqual(['고정.png: 대상 폴더가 없음'])
    const row = (await db.prepare('SELECT folder_id FROM drive_files WHERE id = ?').bind(a.id).first()) as { folder_id: number | null } | null
    expect(row?.folder_id).toBeNull()
  })

  test('plan: 모델이 던지면 502 ai_failed', async () => {
    const db = makeDb()
    const app = createOfficeAiApp({
      chat: (async () => {
        throw new Error('down')
      }) as never,
    })
    const r = await post(app, envOf(db), '/organize/plan', {})
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('ai_failed')
  })
})
