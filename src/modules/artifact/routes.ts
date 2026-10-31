import { Hono } from 'hono'
import type { Env } from '../../types'
import { MODELS } from '../../services/ai'

export const artifactApp = new Hono<{ Bindings: Env }>()

// SHA-256 해시 (Web Crypto)
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 아티팩트 목록 (게시된 것만, 홈화면용) (관문 33: 페이지네이션 지원)
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
artifactApp.get('/:id/versions', async (c) => {
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
artifactApp.get('/:id/versions/:versionNo/files', async (c) => {
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
artifactApp.get('/:id/versions/:fromNo/diff/:toNo', async (c) => {
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
artifactApp.get('/:id/versions/:versionNo', async (c) => {
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

// 새 버전 생성 (기존 게시본 유지, 초안으로 저장)
artifactApp.post('/:id/versions', async (c) => {
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
artifactApp.post('/:id/versions/files', async (c) => {
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
artifactApp.get('/:id/active-job', async (c) => {
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
artifactApp.post('/:id/versions/:versionNo/publish', async (c) => {
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
artifactApp.post('/:id/rollback/:versionNo', async (c) => {
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
artifactApp.post('/:id/publish', async (c) => {
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
artifactApp.post('/chats', async (c) => {
  try {
    const { artifact_id, session_key, who, content } = await c.req.json()
    if (!who || !content) return c.json({ ok: false, error: 'who/content 필요' }, 400)
    const sliced = content.slice(0, 2000)
    // 관문 68: artifact_id가 있으면 소유권 확인
    if (artifact_id) {
      const ownerEmail = (c as any).get('userEmail') as string
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
      ).bind(artifact_id, ownerEmail).first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }
    // 10초 내 동일 메시지 중복 방지
    const dup = await c.env.DB.prepare(
      `SELECT id FROM artifact_chats WHERE artifact_id IS ? AND session_key=? AND who=? AND content=? AND created_at > datetime('now', '-10 seconds') LIMIT 1`
    ).bind(artifact_id || null, session_key || 'new', who, sliced).first() as any
    if (dup) return c.json({ ok: true, deduped: true })
    await c.env.DB.prepare(
      `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, ?, ?)`
    ).bind(artifact_id || null, session_key || 'new', who, sliced).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '저장 실패' }, 500)
  }
})

// 세션 채팅을 프로젝트로 이관 (GPT 자문: 대화 연속성)
artifactApp.post('/chats/migrate', async (c) => {
  try {
    const { from_session, to_artifact_id } = await c.req.json()
    if (!from_session || !to_artifact_id) return c.json({ ok: false, error: 'from_session/to_artifact_id 필요' }, 400)
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 67: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(to_artifact_id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const toKey = 'p' + to_artifact_id
    // 관문 80 (백로그 트랙 A-2): 이관 대상은 artifact_id IS NULL인 고아 세션 채팅뿐이다.
    // 프로젝트 채팅의 session_key는 'p{artifactId}'로 결정적이라, 이 조건이 없으면
    // from_session='p<타인 artifact id>'만으로 타인 프로젝트의 채팅이 통째로 넘어온다.
    // 이미 아티팩트에 붙은 채팅(자기 것 포함)은 이 경로로 절대 이동하지 않는다.
    // from_session 자체의 소유권은 스키마상 검증 수단이 없어, 세션 키를 아는 것을
    // 사실상 보유로 보는 현행 전제를 유지한다 (고아 채팅 한정).
    await c.env.DB.prepare(
      `UPDATE artifact_chats SET artifact_id=?, session_key=? WHERE session_key=? AND artifact_id IS NULL`
    ).bind(to_artifact_id, toKey, from_session).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '이관 실패' }, 500)
  }
})

// 대화 기록 조회
artifactApp.get('/chats', async (c) => {
  try {
    const sessionKey = c.req.query('session_key')
    const artifactId = c.req.query('artifact_id')
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 64: 필터 없이 호출하면 전체 채팅이 노출되므로 session_key/artifact_id 중 하나를 강제한다.
    // (프론트는 항상 session_key를 넘긴다 — agent.html restoreChat/syncChatMsg)
    if (!sessionKey && !artifactId) {
      return c.json({ ok: false, error: 'session_key 또는 artifact_id 필요' }, 400)
    }
    // 관문 64: 소유권 확인 - artifact_id가 있으면 소유권 체크
    if (artifactId) {
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
      ).bind(Number(artifactId), ownerEmail, 'published').first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }
    // session_key가 p{artifactId} 형태면 소유권 체크
    if (sessionKey && sessionKey.startsWith('p')) {
      const aid = Number(sessionKey.slice(1))
      if (aid) {
        const ownerCheck: any = await c.env.DB.prepare(
          'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
        ).bind(aid, ownerEmail, 'published').first()
        if (!ownerCheck) {
          return c.json({ ok: false, error: '권한 없음' }, 403)
        }
      }
    }
    let sql = 'SELECT who, content, created_at FROM artifact_chats WHERE 1=1'
    const params: any[] = []
    if (sessionKey) { sql += ' AND session_key = ?'; params.push(sessionKey) }
    if (artifactId) { sql += ' AND artifact_id = ?'; params.push(Number(artifactId)) }
    sql += ' ORDER BY created_at ASC LIMIT 100'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '채팅 내역 조회 실패' }, 500)
  }
})

// 대화 내용 검색 (프로젝트명 + 채팅)
artifactApp.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') || '').trim()
    if (!q) return c.json({ ok: true, data: { projects: [], chats: [] } })
    const like = `%${q}%`
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 61: 소유권 필터 — 남의 초안 제목·채팅 스니펫이 검색에 노출되지 않는다.
    // owner_email IS NULL은 소유권 모델 이전 레거시 행(백필 전까지 허용).
    // artifact_id IS NULL인 고아 채팅은 소유자를 알 수 없어 기존 동작대로 반환한다.
    const { results: projects } = await c.env.DB.prepare(
      `SELECT id, title, status FROM artifacts WHERE title LIKE ? AND (owner_email = ? OR status = 'published' OR owner_email IS NULL) ORDER BY updated_at DESC LIMIT 10`
    ).bind(like, ownerEmail).all()
    const { results: chats } = await c.env.DB.prepare(
      `SELECT c.session_key, c.artifact_id, c.who, substr(c.content, 1, 120) as snippet, a.title as artifact_title
       FROM artifact_chats c LEFT JOIN artifacts a ON a.id = c.artifact_id
       WHERE c.content LIKE ? AND (a.owner_email = ? OR a.status = 'published' OR c.artifact_id IS NULL OR a.owner_email IS NULL) ORDER BY c.created_at DESC LIMIT 20`
    ).bind(like, ownerEmail).all()
    return c.json({ ok: true, data: { projects: projects || [], chats: chats || [] } })
  } catch (e) {
    return c.json({ ok: false, error: '검색 실패' }, 500)
  }
})

// 아티팩트 생성 (v1 버전과 함께)
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
artifactApp.post('/jobs', async (c) => {
  try {
    const { kind, artifact_id, prompt, base_html, client_request_id, provider, model } = await c.req.json()
    if (!prompt) return c.json({ ok: false, error: 'prompt 필요' }, 400)
    // 관문 25: 프롬프트 길이 제한 (10000자)
    if (prompt.length > 10000) {
      return c.json({ ok: false, error: 'prompt가 너무 깁니다 (10000자 제한)' }, 400)
    }
    // 관문 76: provider 검증
    // 2026-10-30: NVIDIA 운영 제외 — 유효 provider에서 제거 (NVIDIA를
    // 지정한 잡 생성은 400). 기존 잡 행의 처리는 job-processor가드가 담당.
    const validProviders = ['gemini', 'groq']
    if (provider && !validProviders.includes(provider)) {
      return c.json({ ok: false, error: `provider는 ${validProviders.join('/')} 중 하나여야 합니다` }, 400)
    }
    // 관문 77: base_html 크기 제한 (2MB)
    if (base_html && base_html.length > 2 * 1024 * 1024) {
      return c.json({ ok: false, error: 'base_html이 너무 큽니다 (2MB 제한)' }, 400)
    }
    // 관문 78: model 길이 제한
    if (model && String(model).length > 100) {
      return c.json({ ok: false, error: 'model이 너무 깁니다 (100자 제한)' }, 400)
    }
    // 관문 82: model 실재·활성·provider 일치 검증 (2026-10-30 잠재 경로 하드닝)
    // job-processor는 job.model을 그대로 runStudioAgent에 넘기므로, 레지스트리에
    // 없는 문자열이 저장되면 처리 시점에 가서야 실패한다 — 생성 시점에 거부한다.
    // 같은 id가 복수 provider로 등록된 경우(openai/gpt-oss-20b: groq·nvidia)가
    // 있어, id 단독 find가 아니라 active 후보 집합 기준으로 판정한다.
    if (model) {
      const candidates = MODELS.filter((m) => m.id === String(model))
      if (candidates.length === 0) {
        return c.json({ ok: false, error: 'unknown model' }, 400)
      }
      const active = candidates.filter((m) => m.status === 'active')
      if (active.length === 0) {
        return c.json({ ok: false, error: `model not active: ${candidates[0].status}` }, 400)
      }
      if (provider && !active.some((m) => m.provider === provider)) {
        return c.json({ ok: false, error: 'model/provider mismatch' }, 400)
      }
    }
    // 관문 20: kind 검증
    const validKinds = ['create', 'modify']
    const jobKind = kind || 'create'
    if (!validKinds.includes(jobKind)) {
      return c.json({ ok: false, error: `kind는 ${validKinds.join('/')} 중 하나여야 합니다` }, 400)
    }
    const ownerEmail = (c as any).get('userEmail') as string

    // 관문 79 (백로그 트랙 A-1): artifact_id가 있으면 소유권 확인 — 관문 68(POST /chats)과
    // 동일 패턴(fail-closed). modify 잡은 job-processor가 그 artifact의 draft를 읽고
    // 새 버전을 쓰므로, 타인 artifact_id로 잡을 만들면 타인 프로젝트가 변형된다.
    // 정상 UI(agent.html callAiJob)는 artifact_id로 현재 선택한 자기 프로젝트(curId)만
    // 보내므로, 이 확인이 깨는 정상 경로는 없다. 멱등성 조회보다 먼저 확인해
    // 타인 artifact_id를 담은 요청은 어떤 경우에도 403으로 끝낸다.
    if (artifact_id) {
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
      ).bind(artifact_id, ownerEmail).first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }

    // 멱등성: 같은 client_request_id면 기존 jobId 반환
    if (client_request_id) {
      const existing: any = await c.env.DB.prepare(
        'SELECT id, status FROM artifact_jobs WHERE owner_email=? AND client_request_id=?'
      ).bind(ownerEmail, client_request_id).first()
      if (existing) {
        return c.json({ ok: true, data: { jobId: existing.id, deduped: true } }, 202)
      }
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, base_html, status, owner_email, client_request_id, provider, model) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(jobKind, artifact_id || null, prompt, base_html || null, ownerEmail, client_request_id || null, provider || null, model || null).run()
    const jobId = Number(result.meta.last_row_id)

    // 프로젝트=대화: 새 대화면 artifact(프로젝트)를 즉시 생성 (앱 성공 여부와 무관)
    let finalArtifactId = artifact_id || null
    if (!finalArtifactId) {
      const title = prompt.slice(0, 30).replace(/( 만들어줘| 만들어주세요| 해줘| 해주세요| 부탁해).*$/, '') || '새 대화'
      const artResult = await c.env.DB.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'chat', 'draft', ?, 1, '', ?)`
      ).bind(title, prompt.slice(0, 100), ownerEmail).run()
      finalArtifactId = Number(artResult.meta.last_row_id)
      // job에 artifact_id 연결
      await c.env.DB.prepare(`UPDATE artifact_jobs SET artifact_id=? WHERE id=?`).bind(finalArtifactId, jobId).run()
      // 사용자 메시지를 채팅에 저장 (관문 4: 중복 방지 — 10초 내 동일 메시지 있으면 스킵)
      // 관문 9: session_key를 p${artifactId}로 직접 저장 (프론트 이관 불필요)
      const dupMsg = await c.env.DB.prepare(
        `SELECT id FROM artifact_chats WHERE artifact_id=? AND who='user' AND content=? AND created_at > datetime('now', '-10 seconds') LIMIT 1`
      ).bind(finalArtifactId, prompt.slice(0, 5000)).first() as any
      if (!dupMsg) {
        await c.env.DB.prepare(
          `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, 'user', ?)`
        ).bind(finalArtifactId, `p${finalArtifactId}`, prompt.slice(0, 5000)).run()
      }
    }

    // B1: modify 작업은 시작 시점의 파일 스냅샷+해시를 저장 (B5 충돌 감지/버전 분기의 기준점)
    // ACP 원칙: 브라우저(에디터)가 파일의 주인, 에이전트는 스냅샷을 읽고 diff를 내놓는다
    if (jobKind === 'modify' && finalArtifactId) {
      try {
        const dart: any = await c.env.DB.prepare(
          'SELECT draft_version_id FROM artifacts WHERE id=?'
        ).bind(finalArtifactId).first()
        if (dart?.draft_version_id) {
          const { results: snapFiles } = await c.env.DB.prepare(
            'SELECT file_path, content FROM artifact_files WHERE version_id=?'
          ).bind(dart.draft_version_id).all()
          const snap: Record<string, string> = {}
          for (const r of (snapFiles || []) as any[]) {
            snap[r.file_path] = await sha256(String(r.content || ''))
          }
          await c.env.DB.prepare(
            'UPDATE artifact_jobs SET base_version_id=?, base_snapshot=? WHERE id=?'
          ).bind(dart.draft_version_id, JSON.stringify(snap), jobId).run()
        }
      } catch (e) { /* 스냅샷 실패는 작업 생성을 막지 않음 */ }
    }

    // Queue 기반 비동기 처리 (v2 'Failed to fetch' 수정 — 2026-10-16)
    // 직접 모드(잡 프로세서를 HTTP 핸들러에서 await)는 응답이 에이전트 완료까지 블로킹되어
    // Queue 기반 비동기 처리 (v2 'Failed to fetch' 수정 — 2026-10-16)
    // 직접 모드(잡 프로세서를 HTTP 핸들러에서 await)는 응답이 에이전트 완료까지 블로킹되어
    // 수 분간 유휴 상태가 되면 브라우저가 연결을 끊고 fetch()가 TypeError: Failed to fetch를 throw.
    // Queue Consumer(src/index.ts, 15분 예산)가 잡을 처리하므로 즉시 202 반환.
    // 관문 29: Workflow 제거됨 — Queue가 정답 (waitUntil 30초 제한으로 장시간 작업 불가)
    try {
      await (c.env as any).ARTIFACT_QUEUE.send({ jobId })
    } catch (e: any) {
      await c.env.DB.prepare(
        `UPDATE artifact_jobs SET status='failed', error=?, seen=0 WHERE id=?`
      ).bind('큐 전송 실패: ' + (e.message || 'unknown').slice(0, 200), jobId).run()
      return c.json({ ok: false, jobId, error: '큐 전송 실패' }, 500)
    }
    return c.json({ ok: true, data: { jobId } }, 202)
  } catch (e) {
    return c.json({ ok: false, error: '작업 생성 실패' }, 500)
  }
})

// 작업 상태 조회
artifactApp.get('/jobs/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const job = await c.env.DB.prepare('SELECT * FROM artifact_jobs WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    return c.json({ ok: true, data: job })
  } catch (e) {
    return c.json({ ok: false, error: '작업 상태 조회 실패' }, 500)
  }
})

// A1: ask_question 답변 제출 → 작업 재개
artifactApp.post('/jobs/:id/answer', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const body = await c.req.json().catch(() => ({}))
    const answers = body.answers
    if (!Array.isArray(answers) || answers.length === 0) {
      return c.json({ ok: false, error: 'answers가 필요합니다' }, 400)
    }
    // 답변 형식 검증: [{id, answer}]
    for (const a of answers) {
      if (!a || typeof a.id !== 'string' || typeof a.answer !== 'string') {
        return c.json({ ok: false, error: 'answer 형식이 잘못됐습니다' }, 400)
      }
      if (a.answer.length > 2000) {
        return c.json({ ok: false, error: '답변이 너무 깁니다 (2000자 제한)' }, 400)
      }
    }
    const job: any = await c.env.DB.prepare(
      'SELECT * FROM artifact_jobs WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    if (job.status !== 'awaiting_input') {
      return c.json({ ok: false, error: '입력 대기 중인 작업이 아닙니다' }, 400)
    }
    let ps: any = {}
    try { ps = JSON.parse(job.pending_state || '{}') } catch {}
    // 질문 ID와 매칭되는 답변만 허용
    const questionIds = new Set((ps.questions || []).map((q: any) => q.id))
    const validAnswers = answers.filter((a: any) => questionIds.has(a.id))
    if (validAnswers.length === 0) {
      return c.json({ ok: false, error: '유효한 답변이 없습니다' }, 400)
    }
    ps.answers = validAnswers
    await c.env.DB.prepare(
      `UPDATE artifact_jobs SET status='pending', pending_state=?, updated_at=datetime('now') WHERE id=?`
    ).bind(JSON.stringify(ps), id).run()
    // Queue로 재개 (claim이 pending을 획득)
    try {
      await (c.env as any).ARTIFACT_QUEUE.send({ jobId: id })
    } catch (e: any) {
      await c.env.DB.prepare(
        `UPDATE artifact_jobs SET status='failed', error=? WHERE id=?`
      ).bind('큐 전송 실패: ' + (e.message || 'unknown').slice(0, 200), id).run()
      return c.json({ ok: false, error: '큐 전송 실패' }, 500)
    }
    return c.json({ ok: true, data: { jobId: id } }, 202)
  } catch (e) {
    return c.json({ ok: false, error: '답변 제출 실패' }, 500)
  }
})

// Job 이벤트 스트림 조회 (Codex 스타일)
artifactApp.get('/jobs/:id/events', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const since = Number(c.req.query('since') || 0)
    // 관문 65: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifact_jobs WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const { results } = await c.env.DB.prepare(
      'SELECT id, event_type, payload, created_at FROM artifact_job_events WHERE job_id=? AND id>? ORDER BY id ASC LIMIT 100'
    ).bind(id, since).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '작업 이벤트 조회 실패' }, 500)
  }
})

// 진행 중인 작업 + 미확인 완료 작업 목록
artifactApp.get('/jobs', async (c) => {
  try {
    const ownerEmail = (c as any).get('userEmail') as string
    const { results } = await c.env.DB.prepare(
      `SELECT j.*, a.title as artifact_title FROM artifact_jobs j
       LEFT JOIN artifacts a ON a.id = j.artifact_id
       WHERE j.owner_email = ? AND (j.status IN ('pending','running') OR (j.status IN ('done','failed') AND j.seen = 0))
       ORDER BY j.created_at DESC LIMIT 20`
    ).bind(ownerEmail).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '내 작업 목록 조회 실패' }, 500)
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
artifactApp.post('/jobs/:id/seen', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    await c.env.DB.prepare(`UPDATE artifact_jobs SET seen=1 WHERE id=? AND owner_email=?`).bind(id, ownerEmail).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '처리 실패' }, 500)
  }
})

// AI 모델 변경 (레지스트리 활성 모델만 허용)
// 2026-10-30: 이전에는 NVIDIA 모델만 허용하던 엔드포인트였다 — NVIDIA 운영
// 제외로 정반대가 됐다. 하드코딩 목록 대신 MODELS 레지스트리로 검증한다:
// 미등록 모델은 400, 비활성 모델(NVIDIA 전부 포함)도 400. 중복 id
// (openai/gpt-oss-20b: groq active·nvidia deprecated)는 활성 후보가 하나라도
// 있으면 허용한다 (POST /jobs 관문 82와 같은 판정 방식).
artifactApp.post('/model', async (c) => {
  try {
    const { model } = await c.req.json()
    const candidates = MODELS.filter((m) => m.id === model)
    if (candidates.length === 0) {
      return c.json({ ok: false, error: '허용되지 않은 모델' }, 400)
    }
    if (!candidates.some((m) => m.status === 'active')) {
      return c.json({ ok: false, error: `model not active: ${candidates[0].status}` }, 400)
    }
    await c.env.DB.prepare(
      "UPDATE ai_settings SET value=? WHERE key='model.code'"
    ).bind(model).run()
    return c.json({ ok: true, model })
  } catch (e) {
    return c.json({ ok: false, error: '변경 실패' }, 500)
  }
})

// 작업 취소 (소유자만, pending/running/awaiting_input 상태에서만)
// 관문 81 (백로그 트랙 A-3): awaiting_input도 실제로 취소할 수 있게 한다.
// 이전에는 UPDATE 대상이 pending/running뿐이라 awaiting_input 잡은 0건 변경인데도
// {ok:true}를 반환하는 거짓 성공이었다. 질문 대기 중인 잡을 버릴 방법이 답변뿐이면
// 사용자는 원하지 않는 작업을 강제 재개해야 하므로, 취소 가능 쪽이 옳다:
// - 클라이언트: pollJob이 awaiting_input를 감지해 질문 팝업을 띄우는 동안에도
//   working 행의 취소 버튼(currentJobId)이 그대로 노출·호출된다 (agent.html).
// - 안전성: 큐 claim(job-processor)은 pending/만료된 running만 집으므로
//   failed로 전이된 잡이 다시 실행되지 않고, /answer는 awaiting_input가 아니면
//   400이라 취소 후 답변 재개도 불가능하다.
// 응답-상태 일치: UPDATE 변경이 0건이면 (조회 후 상태가 바뀐 경합) 성공으로
// 보고하지 않고 400을 반환한다.
artifactApp.post('/jobs/:id/cancel', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string

    // 소유권 + 상태 확인
    const job: any = await c.env.DB.prepare(
      'SELECT status FROM artifact_jobs WHERE id=? AND owner_email=?'
    ).bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    if (job.status === 'done' || job.status === 'failed') {
      return c.json({ ok: false, error: '이미 완료된 작업' }, 400)
    }

    // 취소 상태로 변경 (lease 무효화, 질문 대기 상태는 폐기)
    const result = await c.env.DB.prepare(
      `UPDATE artifact_jobs SET status='failed', error='사용자 취소', seen=0, lease_token=NULL, pending_state=NULL, updated_at=datetime('now')
       WHERE id=? AND owner_email=? AND status IN ('pending','running','awaiting_input')`
    ).bind(id, ownerEmail).run()
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json({ ok: false, error: '이미 완료된 작업' }, 400)
    }

    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '취소 실패' }, 500)
  }
})

// 고아 채팅 정리 (관문 24)
// 30일 이상 된 artifact_id 없는 세션 채팅 삭제
artifactApp.post('/chats/cleanup', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `DELETE FROM artifact_chats
       WHERE artifact_id IS NULL
       AND created_at < datetime('now', '-30 days')`
    ).run()
    return c.json({ ok: true, data: { deleted: result.meta?.changes || 0 } })
  } catch (e) {
    return c.json({ ok: false, error: '채팅 정리 실패' }, 500)
  }
})

