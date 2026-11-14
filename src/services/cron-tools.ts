/**
 * AI 채팅용 cron 도구 실행 계층 (마커 + FC 디스패처 공용)
 * - 마커: [CRON_CREATE] / [CRON_LIST] / [CRON_DELETE] / [CRON_TOGGLE]
 *   (루미 등 마커 경로 비서용 — processToolMarkers에서 실행)
 * - FC 디스패처: cron_create / cron_list / cron_set_enabled / cron_delete
 *   (에코 keeper FC 경로용 — memo-tool-dispatcher에서 실행)
 * - 저장소는 services/cron-jobs.ts만 사용한다 (모듈 직접 import 금지).
 * - 메모를 읽지 않으므로 잠금 정책과 무관하다.
 */

import {
  createCronJob,
  getCronJob,
  listCronJobs,
  setCronJobEnabled,
  deleteCronJob,
  type CronJob,
} from './cron-jobs'
import { describeNlCron, parseNlCron } from './nl-cron'
import { parseJsonMarkers, parseRawMarkers } from '../lib/markers'

export interface CronToolResult {
  success: boolean
  data?: any
  error?: string
}

/** FC 도구 호출 1건을 cron 실행기로 위임 (디스패처는 메모 도구 중심 유지) */
export async function dispatchCronToolCall(
  env: any,
  name: string,
  args: any,
): Promise<CronToolResult | null> {
  switch (name) {
    case 'cron_create':
      return executeCronCreate(env, typeof args.text === 'string' ? args.text.trim() : '')
    case 'cron_list':
      return executeCronList(env)
    case 'cron_set_enabled':
      return executeCronToggle(env, args.id, args.enabled)
    case 'cron_delete':
      return executeCronDelete(env, args.id)
    default:
      return null
  }
}
export function formatCronJob(job: CronJob): string {
  const parsed = parseNlCron(job.nlText)
  const desc = parsed ? describeNlCron(parsed) : job.nlText
  const state = job.enabled ? '켜짐' : '꺼짐'
  return `#${job.id} ${desc} (${state})`
}

/**
 * [CRON_CREATE]{"text": "매일 아침 8시에 뉴스 요약해서 푸시해줘"}[/CRON_CREATE] 파싱
 * - text 필드 필수 (자연어 원문 그대로 — 서버가 파싱·검증한다).
 */
export function parseCronCreateMarkers(text: string): Array<{ full: string; text: string }> {
  return parseJsonMarkers(
    text,
    /\[CRON_CREATE\]([\s\S]*?)\[\/CRON_CREATE\]/gi,
    (parsed, full) =>
      parsed.text && typeof parsed.text === 'string' && parsed.text.trim()
        ? { full, text: parsed.text.trim().slice(0, 500) }
        : null,
    2,
  )
}

/** [CRON_LIST][/CRON_LIST] 파싱 (내용 없음) */
export function parseCronListMarkers(text: string): Array<{ full: string }> {
  return parseRawMarkers(
    text,
    /\[CRON_LIST\]([\s\S]*?)\[\/CRON_LIST\]/gi,
    (full) => ({ full }),
    2,
  )
}

/** [CRON_DELETE]{"id": 3}[/CRON_DELETE] 파싱 */
export function parseCronDeleteMarkers(text: string): Array<{ full: string; id: number }> {
  return parseJsonMarkers(
    text,
    /\[CRON_DELETE\]([\s\S]*?)\[\/CRON_DELETE\]/gi,
    (parsed, full) =>
      parsed.id && Number.isInteger(parsed.id) ? { full, id: parsed.id } : null,
    2,
  )
}

/**
 * [CRON_TOGGLE]{"id": 3, "enabled": false}[/CRON_TOGGLE] 파싱
 * - enabled가 없으면 현재 상태의 반대로 토글한다.
 */
export function parseCronToggleMarkers(
  text: string,
): Array<{ full: string; id: number; enabled: boolean | null }> {
  return parseJsonMarkers(
    text,
    /\[CRON_TOGGLE\]([\s\S]*?)\[\/CRON_TOGGLE\]/gi,
    (parsed, full) => {
      if (parsed.id && Number.isInteger(parsed.id)) {
        const enabled =
          typeof parsed.enabled === 'boolean' ? parsed.enabled : null
        return { full, id: parsed.id, enabled }
      }
      return null
    },
    2,
  )
}

/** 자연어 → cron 작업 생성. 파싱 실패 시 success:false (저장 안 함). */
export async function executeCronCreate(env: any, text: string): Promise<CronToolResult> {
  try {
    const job = await createCronJob(env.DB, text)
    if (!job) {
      return {
        success: false,
        error: '시간 표현을 이해하지 못했습니다. "매일 아침 8시에 뉴스 요약해줘"처럼 언제·무엇을인지 알려주세요.',
      }
    }
    const parsed = parseNlCron(text)
    return {
      success: true,
      data: {
        id: job.id,
        action: job.action,
        cronKst: job.cronKst,
        nextRunAt: job.nextRunAt,
        description: parsed ? describeNlCron(parsed) : text,
      },
    }
  } catch (e: any) {
    return { success: false, error: `자동화 저장 실패: ${String(e?.message || e).slice(0, 100)}` }
  }
}

/** 자동화 목록 조회 */
export async function executeCronList(env: any): Promise<CronToolResult> {
  try {
    const jobs = await listCronJobs(env.DB)
    return {
      success: true,
      data: {
        jobs: jobs.map((j) => ({
          id: j.id,
          action: j.action,
          nlText: j.nlText,
          cronKst: j.cronKst,
          nextRunAt: j.nextRunAt,
          enabled: j.enabled,
          description: formatCronJob(j),
        })),
      },
    }
  } catch (e: any) {
    return { success: false, error: `자동화 목록 조회 실패: ${String(e?.message || e).slice(0, 100)}` }
  }
}

/** 자동화 삭제. 없는 id면 실패. */
export async function executeCronDelete(env: any, id: number): Promise<CronToolResult> {
  try {
    const ok = await deleteCronJob(env.DB, id)
    if (!ok) return { success: false, error: `자동화 #${id}를 찾을 수 없어요.` }
    return { success: true, data: { id } }
  } catch (e: any) {
    return { success: false, error: `자동화 삭제 실패: ${String(e?.message || e).slice(0, 100)}` }
  }
}

/**
 * 자동화 활성화/비활성화.
 * - enabled가 null이면 현재 상태의 반대로 토글한다.
 */
export async function executeCronToggle(
  env: any,
  id: number,
  enabled: boolean | null,
): Promise<CronToolResult> {
  try {
    let target = enabled
    if (target === null) {
      const job = await getCronJob(env.DB, id)
      if (!job) return { success: false, error: `자동화 #${id}를 찾을 수 없어요.` }
      target = job.enabled !== 1
    }
    const job = await setCronJobEnabled(env.DB, id, target)
    if (!job) return { success: false, error: `자동화 #${id}를 찾을 수 없어요.` }
    return {
      success: true,
      data: { id: job.id, enabled: job.enabled === 1, description: formatCronJob(job) },
    }
  } catch (e: any) {
    return { success: false, error: `자동화 변경 실패: ${String(e?.message || e).slice(0, 100)}` }
  }
}
