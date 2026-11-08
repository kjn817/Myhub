/**
 * 아티팩트 모듈 — 목록·초안·생성·상세·수정·삭제와 하위 라우트 등록.
 * 버전은 version-routes, 채팅은 chat-routes, 잡은 job-routes가 담당한다.
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { sha256 } from './artifact-utils'
import { registerVersionRoutes } from './version-routes'
import { registerChatRoutes, registerChatCleanup } from './chat-routes'
import { registerJobRoutes, registerJobAdminRoutes } from './job-routes'

export const artifactApp = new Hono<{ Bindings: Env }>()

artifactApp.get('/', async (c) => {
  try {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.type, a.description, a.icon_key, a.created_at,
              v.html_content
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.published_version_id
       WHERE a.status = 'published' AND a.published_version_id IS NOT NULL
       ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all()
    // 하위 호환: 기존 status 기반 (버전 없을 때)
    const legacy = await c.env.DB.prepare(
      "SELECT id, title, type, created_at FROM artifacts WHERE status = 'published' AND published_version_id IS NULL ORDER BY created_at DESC LIMIT 50"
    ).all()
    return c.json({ ok: true, data: [...(results || []), ...(legacy.results || [])] })
  } catch (e) {
    return c.json({ ok: false, error: '게시된 프로젝트 목록 조회 실패' }, 500)
  }
})

// 초안 목록 (관문 33: 페이지네이션 지원)
artifactApp.get('/drafts', async (c) => {
  try {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 61: 소유권 필터 — 남의 초안은 목록에 노출하지 않는다.
    // owner_email IS NULL은 소유권 모델 이전에 만들어진 레거시 행(소유자 미기록)으로,
    // 백필 전까지는 단일 사용자의 기존 초안이 목록에서 사라지지 않도록 허용한다.
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.type, a.description, a.icon_key, a.created_at,
              v.version_no as draft_version
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.draft_version_id
       WHERE a.status = 'draft' AND (a.owner_email = ? OR a.owner_email IS NULL)
       ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
    ).bind(ownerEmail, limit, offset).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '임시저장 프로젝트 목록 조회 실패' }, 500)
  }
})

// 버전 히스토리
registerVersionRoutes(artifactApp)

artifactApp.patch('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const body = await c.req.json()
    const updates: string[] = []
    const params: any[] = []
    // 관문 75: 길이 검증
    if (body.title !== undefined) {
      if (String(body.title).length > 200) return c.json({ ok: false, error: '제목이 너무 깁니다 (200자 제한)' }, 400)
      updates.push('title = ?'); params.push(body.title)
    }
    if (body.description !== undefined) {
      if (String(body.description).length > 1000) return c.json({ ok: false, error: '설명이 너무 깁니다 (1000자 제한)' }, 400)
      updates.push('description = ?'); params.push(body.description)
    }
    if (body.icon_key !== undefined) {
      if (String(body.icon_key).length > 50) return c.json({ ok: false, error: '아이콘이 너무 깁니다 (50자 제한)' }, 400)
      updates.push('icon_key = ?'); params.push(body.icon_key)
    }
    if (updates.length === 0) {
      return c.json({ ok: false, error: '수정할 항목 없음' }, 400)
    }
    updates.push("updated_at = datetime('now')")
    updates.push('row_revision = row_revision + 1')
    params.push(id)
    params.push(ownerEmail) // 관문 60: 소유권 확인
    const result = await c.env.DB.prepare(
      `UPDATE artifacts SET ${updates.join(', ')} WHERE id = ? AND owner_email = ?`
    ).bind(...params).run()
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json({ ok: false, error: '찾을 수 없음' }, 404)
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '수정 실패' }, 500)
  }
})

// 아티팩트 삭제 (버전 포함) (관문 36: batch 트랜잭션)
artifactApp.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    // 존재 확인 (관문 59: 소유권 포함)
    const exists = await c.env.DB.prepare('SELECT id FROM artifacts WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).first()
    if (!exists) {
      return c.json({ ok: false, error: '찾을 수 없음' }, 404)
    }
    // 관련 데이터 모두 삭제 (원자적 batch)
    // parent_version_id는 ON DELETE RESTRICT라, 버전 삭제 전 부모 링크를 먼저 끊어야 한다
    // (안 그러면 버전 체인이 있는 아티팩트 삭제가 FOREIGN KEY 오류로 실패한다 — 2026-10-27 발견).
    const db = c.env.DB
    await db.batch([
      db.prepare('UPDATE artifact_versions SET parent_version_id = NULL WHERE artifact_id = ?').bind(id),
      db.prepare('DELETE FROM artifact_files WHERE version_id IN (SELECT id FROM artifact_versions WHERE artifact_id = ?)').bind(id),
      db.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').bind(id),
      db.prepare('DELETE FROM artifact_chats WHERE artifact_id = ?').bind(id),
      db.prepare('DELETE FROM artifact_job_events WHERE job_id IN (SELECT id FROM artifact_jobs WHERE artifact_id = ?)').bind(id),
      db.prepare('DELETE FROM job_provider_attempts WHERE job_id IN (SELECT id FROM artifact_jobs WHERE artifact_id = ?)').bind(id),
      db.prepare('DELETE FROM artifact_jobs WHERE artifact_id = ?').bind(id),
      db.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
    ])
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '삭제 실패: ' + (e as Error).message }, 500)
  }
})

// 대화 기록 저장 (관문 4: 중복 방지)
registerChatRoutes(artifactApp)

artifactApp.post('/', async (c) => {
  try {
    const { title, html_content, description } = await c.req.json()
    if (!title || !html_content) return c.json({ ok: false, error: 'title과 html_content 필요' }, 400)
    const hash = await sha256(html_content)
    const ownerEmail = (c as any).get('userEmail') as string

    // 아티팩트 + v1 버전을 원자적으로 생성
    const artResult = await c.env.DB.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'html', 'draft', ?, 1, ?, ?)`
    ).bind(title, description || '', html_content, ownerEmail).run()
    const artId = artResult.meta.last_row_id
    const verResult = await c.env.DB.prepare(
      // content_sha256이 스키마(0034) 컬럼이다. content_hash/content_size 컬럼은
      // 존재하지 않아 이전 INSERT는 새 DB·운영 모두에서 500이었다.
      `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type) VALUES (?, 1, ?, ?, 'v1 생성', 'nova')`
    ).bind(artId, html_content, hash).run()
    const verId = verResult.meta.last_row_id
    await c.env.DB.prepare(
      `UPDATE artifacts SET draft_version_id = ? WHERE id = ?`
    ).bind(verId, artId).run()

    return c.json({ ok: true, data: { id: artId, version_no: 1 } })
  } catch (e) {
    return c.json({ ok: false, error: '생성 실패' }, 500)
  }
})

// ===== 백그라운드 작업 큐 =====

// 작업 생성 (즉시 job ID 반환, AI 호출은 백그라운드에서)
registerJobRoutes(artifactApp)

// 앱 실행 (게시본 HTML을 샌드박스 CSP로 서빙)
artifactApp.get('/:id/run', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const row: any = await c.env.DB.prepare(
      `SELECT a.id, v.html_content
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.published_version_id
       WHERE a.id = ? AND (a.owner_email = ? OR a.status = 'published')`
    ).bind(id, ownerEmail).first()
    if (!row) {
      return c.json({ ok: false, error: '찾을 수 없음' }, 404)
    }
    let html = row.html_content
    if (!html) {
      const legacy: any = await c.env.DB.prepare(
        'SELECT html_content FROM artifacts WHERE id = ?'
      ).bind(id).first()
      html = legacy?.html_content || ''
    }
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'sandbox allow-scripts',
    })
  } catch (e) {
    return c.json({ ok: false, error: '앱 실행 실패' }, 500)
  }
})

artifactApp.get('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const row = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.type, a.description, a.icon_key, a.status,
              a.draft_version_id, a.published_version_id, a.row_revision, a.created_at,
              v.html_content, v.version_no as published_version
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.id = a.published_version_id
       WHERE a.id = ? AND (a.owner_email = ? OR a.status = 'published')`
    ).bind(id, ownerEmail).first() as any
    if (!row) {
      return c.json({ ok: false, error: '찾을 수 없음' }, 404)
    }
    if (!row.html_content) {
      const legacy = await c.env.DB.prepare(
        'SELECT html_content FROM artifacts WHERE id = ?'
      ).bind(id).first() as any
      row.html_content = legacy?.html_content || ''
    }
    return c.json({ ok: true, data: row })
  } catch (e) {
    return c.json({ ok: false, error: '모델 설정 조회 실패' }, 500)
  }
})
// 작업 확인 처리
registerJobAdminRoutes(artifactApp)
registerChatCleanup(artifactApp)
