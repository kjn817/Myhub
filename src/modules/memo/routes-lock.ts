/**
 * 메모 잠금 라우트 — 메모 전체 잠금(title_hint 저장 포함), 블록 잠금/해제,
 * 첨부 파일 잠금/해제, 잠긴 첨부 콘텐츠 복호화 서빙.
 * 해제는 checkUnlockPin step-up을 통과해야 한다.
 */

import type { Hono } from 'hono'
import type { Env } from '../../types'
import { encryptContent, decryptContent, isEncrypted } from '../../services/crypto'
import { storageDestroy } from '../../services/storage'
import { checkUnlockPin, requireProtectedAccess, syncTags, extractMemoTitle } from './helpers'

/** 블록 잠금/해제 뒤 태그 재동기화 — 본문을 다시 읽어 태그를 맞춘다. */
async function resyncBlockTags(
  c: any,
  id: string,
  fallbackText?: string | null,
  restore?: { blockId: string; html: string }
): Promise<'ok' | 'failed' | 'skipped'> {
  let text: string | null = typeof fallbackText === 'string' ? fallbackText : null
  try {
    const fresh = (await c.env.DB.prepare('SELECT text FROM memos WHERE id = ?').bind(id).first()) as { text: string } | null
    if (fresh && typeof fresh.text === 'string') text = fresh.text
  } catch {
    // 본문 재조회 실패 시 fallbackText로 진행
  }
  if (text === null) return 'skipped'
  if (restore) {
    const esc = restore.blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const markerRe = new RegExp(`\\\\?\\[LOCKED_BLOCK:${esc}\\\\?\\]`, 'g')
    text = text.replace(markerRe, () => restore.html)
  }
  try {
    await syncTags(c.env.DB, Number(id), text)
    return 'ok'
  } catch (e) {
    console.error('block lock: 태그 재동기화 실패', { id, e })
    return 'failed'
  }
}

export function registerMemoLockRoutes(memoApp: Hono<{ Bindings: Env }>): void {
  // 메모 전체 잠금/해제 — 잠글 때 제목 힌트(title_hint)를 평문으로 남겨
  // 잠긴 상태에서도 목록·검색에 제목이 보이게 한다.
  memoApp.post('/:id/lock', async (c) => {
    const id = c.req.param('id')
    const json = await c.req.json().catch(() => ({})) as any
    const locked = json.locked ? 1 : 0
    const memo = await c.env.DB.prepare('SELECT text, is_locked, title_hint FROM memos WHERE id = ?').bind(id).first<any>()
    if (!memo) return c.json({ error: 'not_found' }, 404)
    if (!locked && memo.is_locked) {
      const pinCheck = await checkUnlockPin(c, json.pin)
      if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status as any)
    }
    let newText: string = memo.text
    const wantLocked = locked ? true : false
    if (wantLocked) {
      if (!isEncrypted(memo.text)) {
        try {
          newText = await encryptContent(c.env, memo.text)
        } catch (e) {
          console.error('Encryption failed:', e)
          return c.json({ error: 'encrypt_failed' }, 500)
        }
      }
    } else {
      if (isEncrypted(memo.text)) {
        try {
          newText = await decryptContent(c.env, memo.text)
        } catch (e) {
          return c.json({ error: 'decrypt_failed' }, 500)
        }
      }
    }
    const titleHint = wantLocked
      ? isEncrypted(memo.text)
        ? memo.title_hint ?? null
        : extractMemoTitle(memo.text) || null
      : null
    await c.env.DB.prepare('UPDATE memos SET is_locked = ?, text = ?, title_hint = ? WHERE id = ?')
      .bind(locked, newText, titleHint, id).run()
    return c.json({ ok: true, is_locked: locked })
  })

  // 블록 잠금: 특정 HTML 블록을 암호화하고 본문에서는 마커로 치환한다
  memoApp.post('/:id/lock-block', async (c) => {
    const id = c.req.param('id')
    const json = await c.req.json().catch(() => ({})) as any
    const html: string = json.html || ''
    if (!html) return c.json({ error: 'empty_html' }, 400)
    try {
      let memo: any = null
      try {
        memo = await c.env.DB.prepare('SELECT id, text, locked_blocks FROM memos WHERE id = ?').bind(id).first()
        if (!memo) {
          return c.json({ error: 'memo_not_found' }, 404)
        }
      } catch (e) {
        console.error('locked_blocks column missing, migration needed')
        return c.json({ error: 'migration_needed', message: "D1에서 ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]' 실행 필요" }, 500)
      }
      const { encryptContent } = await import('../../services/crypto')
      const encrypted = await encryptContent(c.env, html)
      const blockId = 'blk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const marker = `[LOCKED_BLOCK:${blockId}]`
      if (typeof memo.text !== 'string' || !memo.text.includes(html)) {
        return c.json({ error: 'block_not_in_text' }, 409)
      }
      const newBlock = JSON.stringify({ id: blockId, encrypted })
      let updateResult: D1Result
      try {
        updateResult = await c.env.DB.prepare(
          `UPDATE memos
           SET locked_blocks = json_insert(
             COALESCE(NULLIF(locked_blocks, ''), '[]'),
             '$[#]',
             json(?)
           ),
           text = replace(text, ?, ?)
           WHERE id = ? AND instr(text, ?) > 0`
        ).bind(newBlock, html, marker, id, html).run()
      } catch (e) {
        console.error('locked_blocks column missing or json_insert failed:', e)
        return c.json({ error: 'migration_needed', message: 'D1 locked_blocks 컬럼 또는 JSON 함수 확인 필요' }, 500)
      }
      const changes = (updateResult as any).meta?.changes ?? 0
      if (changes === 0) {
        return c.json({ error: 'memo_not_found' }, 404)
      }
      const tagSync = await resyncBlockTags(
        c,
        id,
        typeof memo.text === 'string' ? memo.text.split(html).join(marker) : null
      )
      return c.json({ ok: true, blockId, ...(tagSync === 'failed' ? { warning: 'tag_sync_failed' } : {}) })
    } catch (e) {
      return c.json({ error: 'encrypt_failed' }, 500)
    }
  })

  // 블록 잠금 해제
  memoApp.post('/:id/unlock-block/:blockId', async (c) => {
    const id = c.req.param('id')
    const blockId = c.req.param('blockId')
    const json = await c.req.json().catch(() => ({})) as any
    const memo = await c.env.DB.prepare('SELECT locked_blocks, text FROM memos WHERE id = ?').bind(id).first<any>()
    let blocks: any[] = []
    try {
      const parsed = JSON.parse(memo?.locked_blocks || '[]')
      blocks = Array.isArray(parsed) ? parsed : []
    } catch {
    }
    const block = blocks.find((b) => b && b.id === blockId)
    if (!block) return c.json({ error: 'not_found' }, 404)
    const pinCheck = await checkUnlockPin(c, json.pin)
    if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status as any)
    let html: string
    try {
      const { decryptContent } = await import('../../services/crypto')
      html = await decryptContent(c.env, block.encrypted)
    } catch (e) {
      return c.json({ error: 'decrypt_failed' }, 500)
    }
    try {
      await c.env.DB.prepare(
        `UPDATE memos
         SET locked_blocks = COALESCE((
           SELECT json_group_array(json(value))
           FROM json_each(COALESCE(NULLIF(locked_blocks, ''), '[]'))
           WHERE json_extract(value, '$.id') != ?
         ), '[]')
         WHERE id = ?`
      ).bind(blockId, id).run()
    } catch (e) {
      console.error('unlock-block: locked_blocks 제거 실패', { id, blockId, e })
      return c.json({ ok: true, html, warning: 'unlock_pending' })
    }
    const tagSync = await resyncBlockTags(c, id, memo?.text, { blockId, html })
    return c.json({ ok: true, html, ...(tagSync === 'failed' ? { warning: 'tag_sync_failed' } : {}) })
  })

  // 첨부 파일 잠금/해제 — 실물을 암호화/복호화해 교체 업로드한다
  memoApp.post('/files/:fileId/lock', async (c) => {
    const fileId = c.req.param('fileId')
    const json = await c.req.json().catch(() => ({})) as any
    const locked = json.locked ? 1 : 0
    const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first<any>()
    if (!file) return c.json({ error: 'not_found' }, 404)
    const currentlyLocked = file.is_locked ? true : false
    const wantLocked = locked ? true : false
    if (!wantLocked && currentlyLocked) {
      const pinCheck = await checkUnlockPin(c, json.pin)
      if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status as any)
    }
    const oldStorageKey: string = file.storage_key
    const oldResourceType: string = file.resource_type
    let replacedWithKey: string | null = null
    if (wantLocked && !currentlyLocked) {
      try {
        const { encryptBytes } = await import('../../services/crypto')
        const { storageUpload } = await import('../../services/storage')
        const resp = await fetch(file.url)
        if (resp.ok === false) throw new Error(`storage fetch failed: ${resp.status}`)
        const originalBytes = await resp.arrayBuffer()
        const encryptedBytes = await encryptBytes(c.env, originalBytes)
        const encryptedBlob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
        const encryptedFile = new File([encryptedBlob], file.filename + '.enc', { type: 'application/octet-stream' })
        const up = await storageUpload(c.env, encryptedFile, 'myhub/memo-encrypted')
        await c.env.DB.prepare(
          'UPDATE files SET is_locked = 1, url = ?, storage_key = ? WHERE id = ?'
        ).bind(up.secure_url, up.public_id, fileId).run()
        replacedWithKey = up.public_id
      } catch (e) {
        console.error('File encryption failed:', e)
        return c.json({ error: 'encrypt_failed' }, 500)
      }
    } else if (!wantLocked && currentlyLocked) {
      try {
        const { decryptBytes } = await import('../../services/crypto')
        const { storageUpload } = await import('../../services/storage')
        const resp = await fetch(file.url)
        if (resp.ok === false) throw new Error(`storage fetch failed: ${resp.status}`)
        const encryptedBytes = await resp.arrayBuffer()
        const decryptedBytes = await decryptBytes(c.env, encryptedBytes)
        const decryptedBlob = new Blob([decryptedBytes], { type: file.mime || 'application/octet-stream' })
        const decryptedFile = new File([decryptedBlob], file.filename, { type: file.mime })
        const up = await storageUpload(c.env, decryptedFile, 'myhub/memo')
        await c.env.DB.prepare(
          'UPDATE files SET is_locked = 0, url = ?, storage_key = ? WHERE id = ?'
        ).bind(up.secure_url, up.public_id, fileId).run()
        replacedWithKey = up.public_id
      } catch (e) {
        console.error('File decryption failed:', e)
        return c.json({ error: 'decrypt_failed' }, 500)
      }
    }
    let warning: string | undefined
    if (replacedWithKey && oldStorageKey && oldStorageKey !== replacedWithKey) {
      try {
        const destroyed = await storageDestroy(c.env, oldStorageKey, oldResourceType)
        if (destroyed === false) {
          console.error('File lock: replaced storage object destroy failed', { fileId, oldStorageKey })
          warning = 'storage_cleanup_failed'
        }
      } catch (e) {
        console.error('File lock: replaced storage object destroy failed', { fileId, oldStorageKey, e })
        warning = 'storage_cleanup_failed'
      }
    }
    return c.json({ ok: true, is_locked: locked, ...(warning ? { warning } : {}) })
  })

  // 잠긴 첨부 콘텐츠 — 보호 게이트를 통과해야 복호화해 서빙한다
  memoApp.get('/files/:fileId/content', async (c) => {
    const fileId = c.req.param('fileId')
    const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first<any>()
    if (!file || file.deleted_at) return c.json({ error: 'not_found' }, 404)
    if (file.is_locked) {
      const gate = await requireProtectedAccess(c)
      if (!gate.ok) return c.json(gate.body, gate.status as any)
    }
    if (file.is_locked) {
      try {
        const { decryptBytes } = await import('../../services/crypto')
        const resp = await fetch(file.url)
        if (resp.ok === false) throw new Error(`storage fetch failed: ${resp.status}`)
        const encryptedBytes = await resp.arrayBuffer()
        const decryptedBytes = await decryptBytes(c.env, encryptedBytes)
        return new Response(decryptedBytes, {
          headers: {
            'Content-Type': file.mime || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
          },
        })
      } catch (e) {
        return c.json({ error: 'decrypt_failed' }, 500)
      }
    }
    return c.redirect(file.url, 302)
  })
}
