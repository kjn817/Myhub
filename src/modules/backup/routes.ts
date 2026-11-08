// Phase 4D + P0 (2026-10-29): 암호화 백업을 위한 Worker Batch 엔드포인트
// db.batch()를 사용해 백업 대상 테이블을 하나의 트랜잭션에서 읽기
// AES-256-GCM으로 암호화, 인증 필요, 공개 API 아님
//
// 범위 결정 (docs/backup-restore.md 참조):
// - 마이그레이션으로 생성되는 실제 테이블 59개 중 35개를 백업하고,
//   24개는 아래 BACKUP_EXCLUDED_TABLES에 사유와 함께 명시해 제외한다.
// - 새 마이그레이션 테이블이 어느 쪽에도 없으면 backup-scope 테스트가 실패한다
//   (분류 강제 — 조용한 누락 방지).
// - files 테이블은 Cloudinary 메타데이터를 담고, 암호화 백업은 첨부 실물
//   바이트까지 봉투 안에 포함한다 (트랙 4, 2026-10-31 — 아래 /encrypted
//   핸들러의 attachments 절 참조). 평문 백업(POST /)은 메타데이터만이다.

import { Hono } from 'hono'
import type { Env } from '../../types'
import { requireProtectedAccess } from '../memo/routes'
import { getBackupStatus, getBackupFreshnessCheck, buildBackupReminderText, recordBackupCreation } from './status'
import { deriveKey, arrayBufferToBase64, fetchAttachmentItems, PBKDF2_ITERATIONS, SALT_LENGTH, IV_LENGTH } from './backup-service'

const app = new Hono<{ Bindings: Env }>()

// 백업 상태: GET /api/backup/status
app.get('/status', async (c) => {
  const { status, records } = await getBackupStatus(c.env)
  const freshness = await getBackupFreshnessCheck(c.env)
  return c.json({
    ok: true,
    exists: status.exists,
    latest_at: status.latestAt,
    age_days: status.ageDays,
    stale: status.stale,
    freshness_check: freshness ? {
      checked_at: freshness.checkedAt,
      exists: freshness.exists,
      stale: freshness.stale,
      age_days: freshness.ageDays,
      latest_attachments_included: freshness.latestAttachmentsIncluded,
    } : null,
    regular_count: status.regularCount,
    excluded_count: status.excludedCount,
    total_records: status.totalRecords,
    reminder: buildBackupReminderText(status),
    records: records.map((r) => ({
      created_at: r.createdAt,
      kind: r.kind,
      total_rows: r.totalRows,
      table_count: r.tableCount,
      attachments_included: r.attachmentsIncluded,
    })),
  })
})

// 백업 대상 테이블 (화이트리스트, 35개)
export const BACKUP_TABLES = [
  // 핵심 사용자 데이터
  'memos',
  'memo_tags',
  'schedules',
  'todos',
  'files', // 행 자체는 메타데이터 — 단, 암호화 백업은 첨부 실물 바이트까지 봉투에 포함한다 (아래 /encrypted 첨부 절; 평문 백업은 메타데이터만)
  'drive_folders', // 보관함 폴더 구조 (사용자 데이터)
  'drive_files', // 메타데이터만 (실물은 Cloudinary)
  'reminders',
  // AI 대화·기억
  'ai_conversations',
  'ai_chats',
  'ai_feedback',
  'ai_memory',
  'ai_memory_v2',
  'memo_conversation_context',
  'memory_pages',
  'memory_entities',
  'memory_relations',
  'memory_fact_entities',
  'memory_handoffs',
  // 설정·인증 (해시/토큰 원문이 아닌 해시만 저장되는 테이블 포함)
  'ai_settings',
  'accounts', // password_hash(해시)만
  // auth_pins는 백업 제외 (BACKUP_EXCLUDED_TABLES 사유 참조)
  // 아티팩트 (스튜디오 산출물 본체)
  'artifacts',
  'artifact_files',
  'artifact_versions',
  'artifact_chats',
  // 에이전트·채널 상태
  'agent_handoffs',
  'channel_messages',
  // 미션 상태 (0076): 위임 명세는 사용자의 작업 선언이라 복원 대상이고,
  // Workspace 아티팩트는 게이트를 통과한 작업 산출물 본체다 (원문 PII는 저장되지 않음)
  'missions',
  'mission_workspace_artifacts',
  // 연동·구독 (암호화 백업 안에서만 보관 — 복원 시 재연동/재구독 불필요)
  'google_integrations', // OAuth 토큰 포함 — 암호화 백업 전용
  'push_subscriptions', // 구독 endpoint·키 포함 — 암호화 백업 전용
  'mcp_tokens', // token_hash(해시)만
  // 자동화·승인 상태
  'user_cron_jobs',
  'tool_approvals',
  'tool_approval_requests',
]

// 백업 제외 테이블 (24개) — 사유 없이는 추가할 수 없다 (backup-scope 테스트가 강제)
// FTS 가상 테이블(memos_fts, ai_memory_fts, memos_fts_tri 및 섀도우 테이블)은
// 마이그레이션 + 트리거로 재생성되므로 어느 목록에도 넣지 않는다.
export const BACKUP_EXCLUDED_TABLES: Record<string, string> = {
  // 휘발성·보안: 복원하면 오히려 해가 되는 테이블
  auth_pins:
    'PIN 해시(pin_hash·pin_salt·iterations) — 탈취 세션으로 발급한 암호화 백업은 공격자가 백업 암호를 정하므로, 복호화된 백업이 오프라인 PIN 추측 경로가 된다. PIN은 복원 대상이 아니라 복원 후 이메일 OTP 본인확인으로 재설정하는 것이 정당한 절차',
  otp_codes: '일회성 인증코드 — 복원 시 만료/사용済 코드가 되살아나는 보안 위험, 재발급이 정답',
  rate_limits: '시간창 카운터 — 휘발성, 복원 가치 없음',
  session_versions: '세션 세대 카운터 — 옛 값을 복원하면 무효화된 세션이 되살아날 수 있음. 복원 후 재로그인이 정답',
  // 로그·감사·사용량 원장: 사용자 콘텐츠가 아니고 복원 대상 서비스 상태가 아님 (성장성만 큼)
  ai_usage: 'LLM 사용량 원장(통계) — 콘텐츠 아님',
  ai_error_log: '오류 로그',
  ai_memo_audit: '메모 접근 감사 로그',
  tool_execution_audit: '도구 실행 감사 로그',
  google_sync_log: 'Google 동기화 로그',
  job_provider_attempts: '잡 프로바이더 시도 로그',
  artifact_job_events: '아티팩트 잡 이벤트 로그',
  memory_consolidation_log: '기억 통합 로그',
  ai_runs: 'AI 실행 이력 로그',
  ai_tool_runs: '도구 실행 이력(OTel 스팬 포함) 로그',
  clef_decision_log: 'Clef 라우팅 결정 로그 — 콘텐츠 아님',
  // 실행 중 상태: 복원 시점에 이미 낡았고, stale한 진행 중 상태를 되살리면 위험
  agent_runs: '에이전트 실행 이력',
  agent_run_checkpoints: '에이전트 실행 체크포인트 — stale 재개 위험',
  workflow_runs: '워크플로 실행 이력',
  workflow_run_steps: '워크플로 실행 단계 이력',
  artifact_jobs: '아티팩트 잡 큐 상태 — stale한 running 잡 부활 위험 (산출물 본체는 artifacts에 있음)',
  ai_tool_operations: '도구 실행 멱등성 기록 — 실행 시점에만 의미 있음',
  mcp_tasks: 'MCP 태스크 폴링 상태 — 단命 실행 상태',
  mission_attempts: 'Mission 실행 시도 이력 — stale 재개 위험 (명세·산출물 본체는 missions·mission_workspace_artifacts로 백업됨)',
  mission_evaluations: 'Mission 평가 이력 — 실행 시점 기록이라 복원 대상 아님',
}

// PBKDF2 파라미터 (Workers 제한 고려)
// 암호화된 백업: POST /api/backup/encrypted
// 요청 본문: { password: string }
// 응답: { version, algorithm, kdf, iterations, salt, iv, ciphertext, ... }
app.post('/encrypted', async (c) => {
  const env = c.env as any

  // 암호화 백업은 운영에서도 허용한다 (P0, 2026-10-29).
  // 근거: 인증 세션 + 백업 암호(최소 8자)가 필수이고 산출물은 AES-256-GCM
  // 암호문만 나가므로, 운영 차단 시 정작 백업이 필요한 운영 데이터를
  // 백업할 방법이 없어진다 (구 정책은 UI만 있고 운영에선 항상 403이었다).
  // 평문 백업(POST /)은 계속 스테이징 전용이다.
  // ENVIRONMENT 미설정·미지 값은 fail-closed로 차단한다.
  if (env.ENVIRONMENT !== 'staging' && env.ENVIRONMENT !== 'production') {
    return c.json({ error: '백업 API를 사용할 수 없는 환경입니다' }, 403)
  }

  // 인증 확인
  const userEmail = (c as any).get('userEmail')
  if (!userEmail) {
    return c.json({ error: '인증 필요' }, 401)
  }

  // step-up 게이트 (트랙 1, GPT 재평가 P0-3): 백업 발급은 전체 데이터
  // (일반 메모·AI 대화·일정 포함)를 내보내므로 세션만으로는 부족하다.
  // 보호 메모와 같은 집행점(requireProtectedAccess)을 그대로 쓴다:
  // PIN 설정 계정은 5분 step-up 창이 없으면 403 STEP_UP_REQUIRED,
  // PIN 미설정 계정은 면제 (lockout 방지, 기존 정책과 동일).
  const gate = await requireProtectedAccess(c)
  if (!gate.ok) return c.json(gate.body, gate.status)

  // 비밀번호 확인 (URL 쿼리나 로그에 저장하지 않음)
  let password: string | undefined
  let includeAttachments = true
  let backupKind: unknown
  try {
    const body = await c.req.json()
    password = body.password
    // 첨부 실물 포함이 기본이다. 끄려면 명시적으로 false를 보내야 하고,
    // 그 경우 봉투 안에 included:false로 남아 복원 시점에 구분된다.
    if (body.includeAttachments === false) includeAttachments = false
    backupKind = body.kind
  } catch {
    // JSON 파싱 실패
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return c.json({ error: '백업 암호가 필요합니다 (최소 8자)' }, 400)
  }

  try {
    const MAX_BACKUP_SIZE = 10 * 1024 * 1024

    // 백업 대상 테이블을 하나의 batch로 읽기
    const statements = BACKUP_TABLES.map(table =>
      env.DB.prepare(`SELECT * FROM ${table}`)
    )

    const startTime = Date.now()
    const results = await env.DB.batch(statements)
    const duration = Date.now() - startTime

    // 평문 백업 데이터 구성
    const plaintext: Record<string, any> = {
      version: 6, // 암호화 백업 v6 (범위 BACKUP_TABLES 전체 + 첨부 실물 — 트랙 4)
      created_at: new Date().toISOString(),
      method: 'db.batch-transaction',
      tables: {},
    }

    let totalRows = 0
    for (let i = 0; i < BACKUP_TABLES.length; i++) {
      const table = BACKUP_TABLES[i]
      const result = results[i]
      const rows = result.results || []
      plaintext.tables[table] = {
        row_count: rows.length,
        rows: rows,
      }
      totalRows += rows.length
    }

    plaintext.integrity = {
      table_count: BACKUP_TABLES.length,
      total_rows: totalRows,
      duration_ms: duration,
    }

    // ---- 첨부 실물 포함 (트랙 4, 2026-10-31) ----
    // 설계 판단:
    // - files 메타데이터만으로는 Cloudinary 소실 시 첨부를 복원할 수 없어
    //   (구 §4 확정표), 저장 바이트를 그대로 base64로 봉투에 싣는다.
    //   잠긴 첨부의 저장 바이트는 이미 MEMO_ENCRYPTION_KEY 암호문이라
    //   여기서 복호화하지 않는다 — 백업 암호로 한 번 더 감싸진 채로 실리고,
    //   복원 후 열려면 백업 암호 + MEMO_ENCRYPTION_KEY가 모두 필요하다.
    // - fail-closed: 한 파일이라도 내려받지 못하면 백업 전체를 중단한다
    //   (일부 첨부가 빠진 "완전해 보이는" 백업을 만들지 않는다). URL이
    //   없는 행은 실물 자체가 존재하지 않는 레거시 행이라 missing으로
    //   명시 기록하고 계속한다.
    // - 10MB 제한과의 관계: 첨부를 실은 최종 평문이 제한을 넘으면 아래
    //   기존 크기 검사가 413으로 거부한다 (분리·자동 제외는 하지 않는다 —
    //   조용한 불완전 백업 방지). 사전 추정이 명백히 초과하면 다운로드
    //   전에 413으로 끊는다.
    let attachmentCount = 0
    let attachmentBytes = 0
    if (includeAttachments) {
      const fileRows: any[] = plaintext.tables['files']?.rows ?? []
      const estimatedB64 = fileRows.reduce(
        (sum: number, r: any) => sum + Math.ceil((Number(r.size) || 0) * (4 / 3)) + 256,
        0,
      )
      const baseBytes = new TextEncoder().encode(JSON.stringify(plaintext)).length
      // 첨부가 원인이 아닌 초과(본문 자체가 10MB 초과)는 기존 최종 검사가
      // 기존 메시지로 처리하므로, 여기서는 첨부 때문에 넘치는 경우만 끊는다.
      if (estimatedB64 > 0 && baseBytes <= MAX_BACKUP_SIZE && baseBytes + estimatedB64 > MAX_BACKUP_SIZE) {
        return c.json(
          {
            error:
              '첨부 실물을 포함하면 백업 데이터가 10MB 제한을 초과합니다. 첨부를 제외한 백업(includeAttachments:false)이나 스크립트 경로를 사용하세요.',
            code: 'attachments_too_large',
            size: baseBytes + estimatedB64,
            max_size: MAX_BACKUP_SIZE,
          },
          413,
        )
      }
      const fetched = await fetchAttachmentItems(fileRows)
      if (!fetched.ok) {
        // 파일 식별자만 남긴다 (URL·내용은 로그/응답에 남기지 않는다)
        console.log(`[Backup] 첨부 다운로드 실패로 백업 중단: file_id=${fetched.fileId}`)
        return c.json(
          { error: '첨부 파일을 내려받지 못해 백업을 중단했습니다', code: 'attachment_fetch_failed', file_id: fetched.fileId },
          502,
        )
      }
      attachmentCount = fetched.items.length
      attachmentBytes = fetched.totalBytes
      plaintext.attachments = {
        included: true,
        count: attachmentCount,
        total_bytes: attachmentBytes,
        missing_file_ids: fetched.missing,
        items: fetched.items,
      }
    } else {
      plaintext.attachments = { included: false, count: 0, total_bytes: 0, missing_file_ids: [], items: [] }
    }

    // 백업 크기 제한 (10MB)
    // Worker 메모리 128MB 고려, JSON 직렬화 + 암호화 오버헤드 포함
    // 정확한 UTF-8 바이트 수로 측정 (JS 문자열 길이와 다를 수 있음)
    // 사전 검사를 통과했으므로 여기서는 최종 확인
    const plaintextJson = JSON.stringify(plaintext)
    const plaintextBytes = new TextEncoder().encode(plaintextJson).length
    if (plaintextBytes > MAX_BACKUP_SIZE) {
      console.log(`[Backup] 크기 초과: ${plaintextBytes} bytes`)
      return c.json({
        error: '백업 데이터가 너무 큽니다. 최대 10MB까지 지원됩니다.',
        size: plaintextBytes,
        max_size: MAX_BACKUP_SIZE
      }, 413)
    }

    // AES-256-GCM 암호화
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const key = await deriveKey(password, salt)

    const enc = new TextEncoder()
    const plaintextEncoded = enc.encode(JSON.stringify(plaintext))

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      plaintextEncoded
    )

    // 암호화된 백업 구성 (평문 데이터 미포함)
    const encryptedBackup = {
      format_version: 1,
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: arrayBufferToBase64(salt.buffer),
      iv: arrayBufferToBase64(iv.buffer),
      ciphertext: arrayBufferToBase64(ciphertextBuffer),
      created_at: new Date().toISOString(),
      table_count: BACKUP_TABLES.length,
      total_rows: totalRows,
      attachments_included: includeAttachments,
      attachment_count: attachmentCount,
      attachment_bytes: attachmentBytes,
    }

    // 개인정보 원문을 로그에 출력하지 않음
    // 비밀번호도 로그에 출력하지 않음
    await recordBackupCreation(env, {
      kind: backupKind,
      totalRows,
      tableCount: BACKUP_TABLES.length,
      attachmentsIncluded: includeAttachments,
      createdAt: encryptedBackup.created_at,
    })
    console.log(`[Backup] Encrypted backup completed: ${totalRows} rows, ${duration}ms`)

    // 캐시 방지 헤더
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    c.header('Pragma', 'no-cache')
    c.header('Content-Disposition', 'attachment; filename="myhub-backup-encrypted.json"')

    return c.json(encryptedBackup)
  } catch (error) {
    console.error('[Backup] Failed:', error)
    // 내부 오류 정보 노출 방지
    return c.json({ error: '백업 실패' }, 500)
  }
})

// 일관된 백업: 모든 테이블을 하나의 batch 트랜잭션에서 읽기
// POST /api/backup/ (평문, 하위 호환성 유지)
// 인증 필요 (기존 미들웨어에서 처리)
app.post('/', async (c) => {
  const env = c.env as any

  // 프로덕션 차단 (fail-closed: staging에서만 허용)
  // wrangler.toml에 ENVIRONMENT가 없어도 차단됨
  if (env.ENVIRONMENT !== 'staging') {
    return c.json({ error: '백업 API는 스테이징에서만 사용할 수 있습니다' }, 403)
  }

  // 인증 확인 (미들웨어에서 userEmail 설정)
  const userEmail = (c as any).get('userEmail')
  if (!userEmail) {
    return c.json({ error: '인증 필요' }, 401)
  }

  // step-up 게이트 (트랙 1): 평문 발급도 전체 데이터 발급이므로 암호화
  // 발급과 같은 집행점을 적용한다 (스테이징 전용인 점은 위에서 이미 차단).
  const gate = await requireProtectedAccess(c)
  if (!gate.ok) return c.json(gate.body, gate.status)

  try {
    // 백업 대상 테이블을 하나의 batch로 읽기
    // db.batch()는 트랜잭션으로 실행되어 일관된 시점 보장
    // PreparedStatement 배열 사용 (평객체 {sql, params}는 D1_ERROR 발생)
    const statements = BACKUP_TABLES.map(table =>
      env.DB.prepare(`SELECT * FROM ${table}`)
    )

    const startTime = Date.now()
    const results = await env.DB.batch(statements)
    const duration = Date.now() - startTime

    // 결과 구성
    const backup: Record<string, any> = {
      version: 3, // batch 일관성 백업 v3
      created_at: new Date().toISOString(),
      method: 'db.batch-transaction',
      tables: {},
    }

    let totalRows = 0
    for (let i = 0; i < BACKUP_TABLES.length; i++) {
      const table = BACKUP_TABLES[i]
      const result = results[i]
      const rows = result.results || []
      backup.tables[table] = {
        row_count: rows.length,
        rows: rows,
      }
      totalRows += rows.length
    }

    backup.integrity = {
      table_count: BACKUP_TABLES.length,
      total_rows: totalRows,
      duration_ms: duration,
    }

    // 개인정보 원문을 로그에 출력하지 않음
    console.log(`[Backup] Consistent backup completed: ${totalRows} rows, ${duration}ms`)

    // 캐시 방지 헤더
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    c.header('Pragma', 'no-cache')

    return c.json(backup)
  } catch (error) {
    console.error('[Backup] Failed:', error)
    return c.json({ error: '백업 실패' }, 500)
  }
})

export default app
