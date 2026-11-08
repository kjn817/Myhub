/**
 * 최소 인메모리 D1 fake — Octop 트랙 테스트용.
 * 이 트랙의 서비스가 실제로 발행하는 SQL만 처리한다
 * (user_cron_jobs, tool_approvals, schedules 조회).
 * 운영 DB에 닿지 않는다.
 */

type Row = Record<string, any>

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export class FakeD1 {
  tables: Record<string, Row[]> = {
    user_cron_jobs: [],
    tool_approvals: [],
    tool_approval_requests: [],
    schedules: [],
    google_integrations: [],
    google_sync_log: [],
    memos: [],
    todos: [],
    tool_execution_audit: [],
  }
  private seq: Record<string, number> = { user_cron_jobs: 0, tool_approvals: 0, tool_approval_requests: 0, google_sync_log: 0, tool_execution_audit: 0 }

  prepare(sql: string) {
    const q = norm(sql)
    const self = this
    return {
      bind(...args: any[]) {
        return {
          async run() {
            return { success: true, meta: self.run(q, args) }
          },
          async all<T = Row>() {
            return { success: true, results: self.all(q, args) as T[], meta: {} }
          },
          async first<T = Row>(): Promise<T | null> {
            const rows = self.all(q, args)
            return (rows[0] ?? null) as T | null
          },
        }
      },
    }
  }

  private run(q: string, args: any[]): Record<string, any> {
    if (q.startsWith('INSERT INTO user_cron_jobs')) {
      const id = ++this.seq.user_cron_jobs
      const now = new Date().toISOString()
      this.tables.user_cron_jobs.push({
        id,
        action: args[0],
        nl_text: args[1],
        cron_kst: args[2],
        timezone: 'Asia/Seoul',
        next_run_at: args[3],
        enabled: 1,
        created_at: now,
        updated_at: now,
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('UPDATE user_cron_jobs SET enabled')) {
      const [enabled, id] = args
      const row = this.tables.user_cron_jobs.find((r) => r.id === id)
      if (!row) return { changes: 0 }
      row.enabled = enabled
      row.updated_at = new Date().toISOString()
      return { changes: 1 }
    }
    if (q.startsWith('DELETE FROM user_cron_jobs')) {
      const [id] = args
      const before = this.tables.user_cron_jobs.length
      this.tables.user_cron_jobs = this.tables.user_cron_jobs.filter((r) => r.id !== id)
      return { changes: before - this.tables.user_cron_jobs.length }
    }
    if (q.startsWith('UPDATE user_cron_jobs SET next_run_at')) {
      const [nextRunAt, id, expectedOld] = args
      const row = this.tables.user_cron_jobs.find(
        (r) => r.id === id && r.next_run_at === expectedOld,
      )
      if (!row) return { changes: 0 }
      row.next_run_at = nextRunAt
      row.updated_at = new Date().toISOString()
      return { changes: 1 }
    }
    if (q.startsWith('INSERT INTO tool_approvals')) {
      // upsert 의미: 같은 (persona_id, tool, scope_key) 행이 있으면 덮어쓴다
      const [personaId, tool, scopeKey, decision, expiresAt] = args
      const existing = this.tables.tool_approvals.find(
        (r) => r.persona_id === personaId && r.tool === tool && r.scope_key === scopeKey,
      )
      if (existing) {
        existing.decision = decision
        existing.expires_at = expiresAt
        existing.created_at = new Date().toISOString()
        return { last_row_id: existing.id, changes: 1 }
      }
      const id = ++this.seq.tool_approvals
      this.tables.tool_approvals.push({
        id,
        persona_id: personaId,
        tool,
        scope_key: scopeKey,
        decision,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('INSERT INTO tool_approval_requests')) {
      const id = ++this.seq.tool_approval_requests
      this.tables.tool_approval_requests.push({
        id,
        persona_id: args[0],
        conversation_id: args[1],
        tool: args[2],
        scope_key: args[3],
        marker_text: args[4],
        summary: args[5],
        user_request: args[6],
        reversible: args[7],
        impact: args[8],
        status: 'pending',
        created_at: args[9],
        expires_at: args[10],
        decided_at: null,
        executed_at: null,
        execution_result: null,
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('UPDATE tool_approval_requests SET executed_at')) {
      // 0063 claim: status='approved' AND executed_at IS NULL 일 때만 선점
      const [executedAt, id] = args
      const row = this.tables.tool_approval_requests.find(
        (r) => r.id === id && r.status === 'approved' && (r.executed_at === null || r.executed_at === undefined),
      )
      if (!row) return { changes: 0 }
      row.executed_at = executedAt
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE tool_approval_requests SET execution_result')) {
      // 0063 감사 기록: 선점된(executed_at NOT NULL) 행에만 기록
      const [result, id] = args
      const row = this.tables.tool_approval_requests.find(
        (r) => r.id === id && r.executed_at !== null && r.executed_at !== undefined,
      )
      if (!row) return { changes: 0 }
      row.execution_result = result
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE tool_approval_requests SET status')) {
      // markExpired: SET status='expired' (인자 2개) / resolveRequest: SET status=? (인자 3개)
      if (args.length === 2) {
        const [decidedAt, id] = args
        const row = this.tables.tool_approval_requests.find((r) => r.id === id && r.status === 'pending')
        if (!row) return { changes: 0 }
        row.status = 'expired'
        row.decided_at = decidedAt
        return { changes: 1 }
      }
      const [status, decidedAt, id] = args
      const row = this.tables.tool_approval_requests.find((r) => r.id === id && r.status === 'pending')
      if (!row) return { changes: 0 }
      row.status = status
      row.decided_at = decidedAt
      return { changes: 1 }
    }
    if (q.startsWith('DELETE FROM tool_approvals')) {
      const [personaId, tool, scopeKey] = args
      const before = this.tables.tool_approvals.length
      this.tables.tool_approvals = this.tables.tool_approvals.filter(
        (r) => !(r.persona_id === personaId && r.tool === tool && r.scope_key === scopeKey),
      )
      return { changes: before - this.tables.tool_approvals.length }
    }
    if (q.startsWith('INSERT INTO google_integrations')) {
      // upsert: provider='google' 행 1개 (ON CONFLICT DO UPDATE)
      const [provider, email, accessToken, refreshToken, scope, expiresAt] = args
      const existing = this.tables.google_integrations.find((r) => r.provider === provider)
      if (existing) {
        existing.email = email
        existing.access_token = accessToken
        existing.refresh_token = refreshToken
        existing.scope = scope
        existing.expires_at = expiresAt
        existing.status = 'active'
        existing.updated_at = new Date().toISOString()
        return { last_row_id: 1, changes: 1 }
      }
      this.tables.google_integrations.push({
        provider,
        email,
        access_token: accessToken,
        refresh_token: refreshToken,
        scope,
        expires_at: expiresAt,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return { last_row_id: 1, changes: 1 }
    }
    if (q.startsWith('UPDATE google_integrations SET access_token')) {
      // 조건부 UPDATE (refresh 경합 방지): provider + 기존 expires_at 일치 시에만 갱신
      const [accessToken, expiresAt, status, provider, expectedExpiresAt] = args
      const row = this.tables.google_integrations.find(
        (r) => r.provider === provider && r.expires_at === expectedExpiresAt,
      )
      if (!row) return { changes: 0 }
      row.access_token = accessToken
      row.expires_at = expiresAt
      row.status = status
      row.updated_at = new Date().toISOString()
      return { changes: 1 }
    }
    if (q.startsWith('UPDATE google_integrations SET status')) {
      const [status, provider] = args
      const row = this.tables.google_integrations.find((r) => r.provider === provider)
      if (!row) return { changes: 0 }
      row.status = status
      row.updated_at = new Date().toISOString()
      return { changes: 1 }
    }
    if (q.startsWith('DELETE FROM google_integrations')) {
      const [provider] = args
      const before = this.tables.google_integrations.length
      this.tables.google_integrations = this.tables.google_integrations.filter((r) => r.provider !== provider)
      return { changes: before - this.tables.google_integrations.length }
    }
    if (q.startsWith('INSERT INTO google_sync_log')) {
      const id = ++this.seq.google_sync_log
      this.tables.google_sync_log.push({
        id,
        provider: args[0],
        kind: args[1],
        status: args[2],
        detail: args[3],
        created_at: new Date().toISOString(),
      })
      return { last_row_id: id, changes: 1 }
    }
    if (q.startsWith('INSERT INTO tool_execution_audit')) {
      // 샌드박스 격리 감사 로그 (i트랙): preview_shown / executed / denied / expired
      // 0057 OTEL 스팬 필드도 함께 저장한다 (args[7..12]).
      const id = ++this.seq.tool_execution_audit
      this.tables.tool_execution_audit.push({
        id,
        persona_id: args[0],
        conversation_id: args[1],
        tool: args[2],
        scope_key: args[3],
        action: args[4],
        detail: args[5],
        created_at: args[6],
        trace_id: args[7] ?? null,
        span_id: args[8] ?? null,
        parent_span_id: args[9] ?? null,
        tool_call_id: args[10] ?? null,
        duration_ms: args[11] ?? null,
        status: args[12] ?? null,
      })
      return { last_row_id: id, changes: 1 }
    }
    return { changes: 0 }
  }

  private all(q: string, args: any[]): Row[] {
    if (q.includes('FROM user_cron_jobs') && q.includes('ORDER BY created_at DESC')) {
      return [...this.tables.user_cron_jobs].sort((a, b) => b.id - a.id)
    }
    if (q.includes('FROM user_cron_jobs') && q.includes('next_run_at <= ?')) {
      const nowIso = args[0] as string
      return this.tables.user_cron_jobs
        .filter((r) => r.enabled === 1 && r.next_run_at !== null && r.next_run_at <= nowIso)
        .sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : 1))
        .slice(0, 50)
    }
    if (q.includes('FROM user_cron_jobs WHERE id = ?')) {
      return this.tables.user_cron_jobs.filter((r) => r.id === args[0])
    }
    if (q.includes('FROM tool_approvals') && q.includes('ORDER BY id DESC LIMIT 1')) {
      const [personaId, tool, scopeKey] = args
      const rows = this.tables.tool_approvals
        .filter((r) => r.persona_id === personaId && r.tool === tool && r.scope_key === scopeKey)
        .sort((a, b) => b.id - a.id)
      // 실제 D1은 SELECT 별칭(persona_id AS personaId)을 적용하므로 같은 형태로 반환
      return rows.slice(0, 1).map((r) => ({
        id: r.id,
        personaId: r.persona_id,
        tool: r.tool,
        scopeKey: r.scope_key,
        decision: r.decision,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      }))
    }
    if (q.includes('FROM tool_approval_requests') && q.includes('WHERE id = ?')) {
      // getRequestById: 상태 무관 단건 조회 (0063 실행 결과 안내용)
      return this.tables.tool_approval_requests
        .filter((r) => r.id === args[0])
        .map((r) => ({
          id: r.id,
          personaId: r.persona_id,
          conversationId: r.conversation_id,
          tool: r.tool,
          scopeKey: r.scope_key,
          markerText: r.marker_text,
          summary: r.summary,
          userRequest: r.user_request,
          reversible: r.reversible,
          impact: r.impact,
          status: r.status,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          executedAt: r.executed_at ?? null,
          executionResult: r.execution_result ?? null,
        }))
    }
    if (q.includes('FROM tool_approval_requests')) {
      // fetchPendingRow: conversation_id (+scope_key) + status='pending', ORDER BY id DESC LIMIT 1
      const [conversationId, scopeKey] = args
      const rows = this.tables.tool_approval_requests
        .filter(
          (r) =>
            r.conversation_id === conversationId &&
            r.status === 'pending' &&
            (scopeKey === undefined || r.scope_key === scopeKey),
        )
        .sort((a, b) => b.id - a.id)
      return rows.slice(0, 1).map((r) => ({
        id: r.id,
        personaId: r.persona_id,
        conversationId: r.conversation_id,
        tool: r.tool,
        scopeKey: r.scope_key,
        markerText: r.marker_text,
        summary: r.summary,
        userRequest: r.user_request,
        reversible: r.reversible,
        impact: r.impact,
        status: r.status,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        executedAt: r.executed_at ?? null,
        executionResult: r.execution_result ?? null,
      }))
    }
    if (q.includes('FROM schedules')) {
      // i트랙 dry-run: 단건 조회(WHERE id = ?)는 id로 필터링한다.
      if (q.includes('WHERE id = ?')) {
        return this.tables.schedules.filter((r) => r.id === args[0])
      }
      // 일정 조회는 쿼리가 두 번 발행된다 (단건 + 반복).
      // 반복 쿼리(recurrence_rule IS NOT NULL)에는 반복 행만, 단건 쿼리에는 단건 행만 반환한다.
      if (q.includes('recurrence_rule IS NOT NULL')) {
        return this.tables.schedules.filter((r) => r.recurrence_rule)
      }
      return this.tables.schedules.filter((r) => !r.recurrence_rule)
    }
    if (q.includes('FROM memos WHERE id = ?')) {
      // i트랙 dry-run: SELECT id, substr(text,1,200) AS snippet, sensitivity, is_locked
      return this.tables.memos
        .filter((r) => r.id === args[0])
        .map((r) => ({
          id: r.id,
          snippet: String(r.text ?? '').slice(0, 200),
          sensitivity: r.sensitivity ?? 1,
          is_locked: r.is_locked ?? 0,
        }))
    }
    if (q.includes('FROM todos WHERE id = ?')) {
      // i트랙 dry-run: SELECT id, title, status
      return this.tables.todos.filter((r) => r.id === args[0])
    }
    if (q.includes('FROM tool_execution_audit')) {
      // i트랙 감사 조회: WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
      const [conversationId, limit] = args
      return [...this.tables.tool_execution_audit]
        .filter((r) => r.conversation_id === conversationId)
        .sort((a, b) => b.id - a.id)
        .slice(0, typeof limit === 'number' ? limit : 20)
        .map((r) => ({
          id: r.id,
          personaId: r.persona_id,
          conversationId: r.conversation_id,
          tool: r.tool,
          scopeKey: r.scope_key,
          action: r.action,
          detail: r.detail,
          createdAt: r.created_at,
        }))
    }
    if (q.includes('FROM google_integrations WHERE provider = ?')) {
      return this.tables.google_integrations.filter((r) => r.provider === args[0])
    }
    if (q.includes('FROM google_sync_log')) {
      return [...this.tables.google_sync_log].sort((a, b) => b.id - a.id).slice(0, 5)
    }
    return []
  }
}

/** D1Database 타입 위치에 fake를 끼우기 위한 캐스트 */
export function asD1(fake: FakeD1): D1Database {
  return fake as unknown as D1Database
}
