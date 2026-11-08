/**
 * 아티팩트 버전 라우트 — 버전 히스토리·파일·diff·수동 버전 생성·게시·롤백.
 */

import type { Hono } from 'hono'
import type { Env } from '../../types'
import { sha256 } from './artifact-utils'

// 관문 72: 오래된 버전 정리 (50개 초과 시, published 제외)
// job-processor.ts saveJobResult와 동일 정책. 수동 버전 생성 경로에도 적용한다
// (없으면 수동 편집만으로 버전이 무한히 쌓인다).
async function pruneOldVersions(db: any, artifactId: number): Promise<void> {
  try {
    const artInfo: any = await db.prepare(
      'SELECT published_version_id FROM artifacts WHERE id=?'
    ).bind(artifactId).first()
    const pubId = artInfo?.published_version_id || 0
    // parent_version_id는 ON DELETE RESTRICT라, 정리 대상을 부모로 가리키는 링크를 먼저 끊어야 한다
    // (안 그러면 버전 체인이 있는 경우 정리 자체가 FOREIGN KEY 오류로 실패한다 — 2026-10-27 발견).
    await db.prepare(
      `UPDATE artifact_versions SET parent_version_id = NULL
       WHERE artifact_id = ? AND parent_version_id IN (
         SELECT id FROM artifact_versions WHERE artifact_id = ? AND id NOT IN (
           SELECT id FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no DESC LIMIT 50
         ) AND id != ?
       )`
    ).bind(artifactId, artifactId, artifactId, pubId).run()
    await db.prepare(
      `DELETE FROM artifact_versions WHERE artifact_id=? AND id NOT IN (
         SELECT id FROM artifact_versions WHERE artifact_id=? ORDER BY version_no DESC LIMIT 50
       ) AND id != ?`
    ).bind(artifactId, artifactId, pubId).run()
  } catch (e) {
    console.warn('버전 정리 실패:', e)
  }
}

export function registerVersionRoutes(app: Hono<{ Bindings: Env }>): void {
app.get('/:id/versions', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 61: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
    ).bind(id, ownerEmail, 'published').first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, version_no, parent_version_id, content_sha256, change_note,
              source_type, created_by, created_at,
              length(html_content) as content_size
       FROM artifact_versions
       WHERE artifact_id = ?
       ORDER BY version_no DESC`
    ).bind(id).all()
    const artifact = await c.env.DB.prepare(
      'SELECT draft_version_id, published_version_id FROM artifacts WHERE id = ?'
    ).bind(id).first() as any
    return c.json({
      ok: true,
      data: {
        versions: results || [],
        draft_version_id: artifact?.draft_version_id || null,
        published_version_id: artifact?.published_version_id || null,
      },
    })
  } catch (e) {
    return c.json({ ok: false, error: '프로젝트 상세 조회 실패' }, 500)
  }
})

// 버전의 파일 목록 조회 (다중 파일 프로젝트용)
app.get('/:id/versions/:versionNo/files', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const versionNo = Number(c.req.param('versionNo'))
    // 관문 62: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
    ).bind(id, ownerEmail, 'published').first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const version = await c.env.DB.prepare(
      'SELECT id FROM artifact_versions WHERE artifact_id = ? AND version_no = ?'
    ).bind(id, versionNo).first() as any
    if (!version) return c.json({ ok: false, error: '버전 없음' }, 404)
    const { results } = await c.env.DB.prepare(
      'SELECT file_path, content, file_size FROM artifact_files WHERE version_id = ? ORDER BY file_path'
    ).bind(version.id).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '버전 파일 목록 조회 실패' }, 500)
  }
})

// 두 버전 간 Diff (Codex 스타일)
app.get('/:id/versions/:fromNo/diff/:toNo', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const fromNo = Number(c.req.param('fromNo'))
    const toNo = Number(c.req.param('toNo'))
    // 관문 63: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
    ).bind(id, ownerEmail, 'published').first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const getFiles = async (vno: number) => {
      const v = await c.env.DB.prepare(
        'SELECT id FROM artifact_versions WHERE artifact_id=? AND version_no=?'
      ).bind(id, vno).first() as any
      if (!v) return {}
      const { results } = await c.env.DB.prepare(
        'SELECT file_path, content FROM artifact_files WHERE version_id=?'
      ).bind(v.id).all()
      const map: Record<string, string> = {}
      for (const r of (results || []) as any[]) map[r.file_path] = r.content
      return map
    }
    const fromFiles = await getFiles(fromNo)
    const toFiles = await getFiles(toNo)
    const allPaths = new Set([...Object.keys(fromFiles), ...Object.keys(toFiles)])
    const { unifiedDiff } = await import('../../lib/text-diff')
    const changes: any[] = []
    for (const path of allPaths) {
      const oldC = fromFiles[path]
      const newC = toFiles[path]
      if (oldC === undefined) {
        changes.push({ path, type: 'added', lines_added: newC.split('\n').length })
      } else if (newC === undefined) {
        changes.push({ path, type: 'deleted', lines_removed: oldC.split('\n').length })
      } else if (oldC !== newC) {
        // A5: 실제 unified diff 포함
        const diff = unifiedDiff(oldC, newC, path)
        changes.push({ path, type: 'modified', diff: diff.slice(0, 20000) })
      }
    }
    return c.json({ ok: true, data: { changes, from: fromNo, to: toNo } })
  } catch (e) {
    return c.json({ ok: false, error: 'Diff 실패' }, 500)
  }
})

// 특정 버전 내용 조회
app.get('/:id/versions/:versionNo', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const versionNo = Number(c.req.param('versionNo'))
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 61: 소유권 확인 먼저 — 단일 버전 조회에도 히스토리와 동일한 규칙을 적용한다.
    // (이전에는 소유권 확인이 없어 남의 초안 HTML을 버전 번호만 알면 읽을 수 있었다)
    // 의도된 순서이다: 타인에게는 없는 버전도 403을 반환해 버전 존재 여부를 노출하지
    // 않는다 ("존재 여부 노출 방지" — POST /:id/versions·gate-65와 동일 패턴,
    // gate-61이 실DB로 고정). 소유자인 경우에만 없는 버전이 404가 된다.
    // 2026-10-27: 존재 확인 우선으로 바꾸면 gate-61(타인+없는 버전 → 403)이 깨지므로
    // 소유권 우선으로 유지한다. artifact-routes 단위 테스트의 큐 누락이 원인이었다.
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
    ).bind(id, ownerEmail, 'published').first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const row = await c.env.DB.prepare(
      `SELECT id, version_no, parent_version_id, html_content, content_sha256,
              manifest_json, change_note, source_type, created_by, created_at
       FROM artifact_versions
       WHERE artifact_id = ? AND version_no = ?`
    ).bind(id, versionNo).first()
    if (!row) {
      return c.json({ ok: false, error: '버전을 찾을 수 없음' }, 404)
    }
    return c.json({ ok: true, data: row })
  } catch (e) {
    return c.json({ ok: false, error: '버전 상세 조회 실패' }, 500)
  }
})

// 새 버전 생성 (기존 게시본 유지, 초안으로 저장)
app.post('/:id/versions', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const body = await c.req.json()
    const { html_content, change_note, source_type = 'manual' } = body
    if (!html_content || typeof html_content !== 'string') {
      return c.json({ ok: false, error: 'html_content 필수' }, 400)
    }
    if (html_content.length > 2 * 1024 * 1024) {
      return c.json({ ok: false, error: 'HTML이 너무 큼 (2MB 제한)' }, 400)
    }

    const artifact = await c.env.DB.prepare(
      'SELECT id, row_revision, draft_version_id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first() as any
    if (!artifact) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    if (body.row_revision !== undefined && body.row_revision !== artifact.row_revision) {
      return c.json({ ok: false, error: 'CONFLICT: 다른 탭에서 수정됨. 새로고침 후 다시 시도하세요.' }, 409)
    }

    const maxRow = await c.env.DB.prepare(
      'SELECT MAX(version_no) as max_no FROM artifact_versions WHERE artifact_id = ?'
    ).bind(id).first() as any
    const nextNo = (maxRow?.max_no || 0) + 1
    const hash = await sha256(html_content)

    const versionResult = await c.env.DB.prepare(
      `INSERT INTO artifact_versions
       (artifact_id, version_no, parent_version_id, html_content, content_sha256,
        manifest_json, change_note, source_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, nextNo, artifact.draft_version_id || null, html_content, hash,
      JSON.stringify(body.manifest || {}), change_note || '', source_type, 'user'
    ).run()
    const versionId = versionResult.meta?.last_row_id

    await c.env.DB.prepare(
      `UPDATE artifacts
       SET draft_version_id = ?, status = 'draft', row_revision = row_revision + 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(versionId, id).run()

    // 관문 72: 오래된 버전 정리 (50개 초과 시, published 제외)
    await pruneOldVersions(c.env.DB, id)

    return c.json({ ok: true, data: { version_id: versionId, version_no: nextNo } })
  } catch (e) {
    return c.json({ ok: false, error: '버전 생성 실패' }, 500)
  }
})

// B3: 파일 단위 저장 — 코드 탭에서 파일별로 편집한 내용을 새 버전으로 저장
// ACP 원칙: 브라우저(에디터)가 파일의 주인. artifact_files를 직접 갱신하고 미리보기 HTML을 재조합.
app.post('/:id/versions/files', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const body = await c.req.json()
    const { files, change_note } = body
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
      return c.json({ ok: false, error: 'files 객체가 필요합니다' }, 400)
    }
    // 관문 59: 소유권 확인
    const artifact: any = await c.env.DB.prepare(
      'SELECT id, row_revision, draft_version_id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!artifact) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    // 경로 검증 (관문 44)
    for (const p of Object.keys(files)) {
      if (!p || p.includes('..') || p.startsWith('/')) {
        return c.json({ ok: false, error: `잘못된 경로: ${p}` }, 400)
      }
      const content = String((files as any)[p] ?? '')
      if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) {
        return c.json({ ok: false, error: `${p}: 파일이 너무 큼 (2MB 제한)` }, 400)
      }
    }
    // 현재 파일들 로드 (없으면 html_content에서 합성)
    let current: Record<string, string> = {}
    if (artifact.draft_version_id) {
      const { results } = await c.env.DB.prepare(
        'SELECT file_path, content FROM artifact_files WHERE version_id=?'
      ).bind(artifact.draft_version_id).all()
      for (const r of (results || []) as any[]) current[r.file_path] = r.content
    }
    if (Object.keys(current).length === 0) {
      const v: any = await c.env.DB.prepare(
        'SELECT html_content FROM artifact_versions WHERE id=?'
      ).bind(artifact.draft_version_id).first()
      if (v?.html_content) current = { 'index.html': v.html_content }
    }
    const merged: Record<string, string> = { ...current }
    for (const [p, content] of Object.entries(files)) {
      merged[p] = String(content ?? '')
    }
    // 미리보기 HTML 재조합
    const { StudioWorkspace, saveWorkspaceToD1 } = await import('../../services/studio-workspace')
    const ws = new StudioWorkspace(merged)
    let html = ws.getPreviewHtml()
    if (!html) html = merged['index.html'] || Object.values(merged)[0] || ''
    if (!html.trim()) {
      return c.json({ ok: false, error: '저장할 내용이 비어있습니다' }, 400)
    }
    const maxRow: any = await c.env.DB.prepare(
      'SELECT MAX(version_no) as max_no FROM artifact_versions WHERE artifact_id = ?'
    ).bind(id).first()
    const nextNo = (maxRow?.max_no || 0) + 1
    const hash = await sha256(html)
    const vr = await c.env.DB.prepare(
      `INSERT INTO artifact_versions
       (artifact_id, version_no, parent_version_id, html_content, content_sha256, change_note, source_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 'user')`
    ).bind(id, nextNo, artifact.draft_version_id || null, html, hash, (change_note || '사용자 직접 편집').slice(0, 100)).run()
    const versionId = Number(vr.meta.last_row_id)
    await saveWorkspaceToD1(c.env.DB, versionId, merged)
    await c.env.DB.prepare(
      `UPDATE artifacts SET draft_version_id=?, status='draft', row_revision=row_revision+1, project_type='multi', updated_at=datetime('now') WHERE id=?`
    ).bind(versionId, id).run()
    // 관문 72: 오래된 버전 정리 (50개 초과 시, published 제외)
    await pruneOldVersions(c.env.DB, id)
    return c.json({ ok: true, data: { version_id: versionId, version_no: nextNo } })
  } catch (e: any) {
    return c.json({ ok: false, error: '파일 저장 실패' }, 500)
  }
})

// B4: 진행 중인 작업 조회 — 코드 탭의 소프트 파일 잠금용
// 에이전트 작업 중에 사용자가 저장하면 B5 버전 분기가 발생하므로 미리 경고
app.get('/:id/active-job', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const job: any = await c.env.DB.prepare(
      `SELECT id, kind, status FROM artifact_jobs
       WHERE artifact_id=? AND status IN ('pending','running','awaiting_input')
       ORDER BY id DESC LIMIT 1`
    ).bind(id).first()
    return c.json({ ok: true, data: job ? { job_id: job.id, kind: job.kind, status: job.status } : null })
  } catch (e) {
    return c.json({ ok: false, error: '조회 실패' }, 500)
  }
})

// 버전 게시
app.post('/:id/versions/:versionNo/publish', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const versionNo = Number(c.req.param('versionNo'))
    // 관문 59: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const version = await c.env.DB.prepare(
      'SELECT id FROM artifact_versions WHERE artifact_id = ? AND version_no = ?'
    ).bind(id, versionNo).first() as any
    if (!version) {
      return c.json({ ok: false, error: '버전을 찾을 수 없음' }, 404)
    }
    const result = await c.env.DB.prepare(
      `UPDATE artifacts
       SET published_version_id = ?, draft_version_id = ?, status = 'published',
           row_revision = row_revision + 1, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(version.id, version.id, id).run()
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json({ ok: false, error: '아티팩트를 찾을 수 없음' }, 404)
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '게시 실패' }, 500)
  }
})

// 롤백
app.post('/:id/rollback/:versionNo', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const versionNo = Number(c.req.param('versionNo'))
    // 관문 59: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const version = await c.env.DB.prepare(
      'SELECT id FROM artifact_versions WHERE artifact_id = ? AND version_no = ?'
    ).bind(id, versionNo).first() as any
    if (!version) {
      return c.json({ ok: false, error: '버전을 찾을 수 없음' }, 404)
    }
    await c.env.DB.prepare(
      `UPDATE artifacts
       SET published_version_id = ?, row_revision = row_revision + 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(version.id, id).run()
    return c.json({ ok: true, data: { rolled_back_to: versionNo } })
  } catch (e) {
    return c.json({ ok: false, error: '롤백 실패' }, 500)
  }
})

// 초안 게시 (기존 호환)
app.post('/:id/publish', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 59: 소유권 확인
    const artifact = await c.env.DB.prepare(
      'SELECT draft_version_id FROM artifacts WHERE id = ? AND status = ? AND owner_email = ?'
    ).bind(id, 'draft', ownerEmail).first() as any
    if (!artifact) {
      return c.json({ ok: false, error: '초안을 찾을 수 없음' }, 404)
    }
    if (artifact.draft_version_id) {
      await c.env.DB.prepare(
        `UPDATE artifacts
         SET published_version_id = draft_version_id, status = 'published',
             row_revision = row_revision + 1, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(id).run()
    } else {
      await c.env.DB.prepare(
        "UPDATE artifacts SET status = 'published', updated_at = datetime('now') WHERE id = ?"
      ).bind(id).run()
    }
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '게시 실패' }, 500)
  }
})

// 아티팩트 상세 (게시된 버전 내용 포함)

// 아티팩트 메타데이터 수정
}
