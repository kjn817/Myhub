import { getSetting } from './ai-model-selection'

export const ENGINE_V2_KEY_PREFIX = 'ai.engine_v2.'

export async function isFcEnabledForPersona(db: D1Database, personaId?: string | null): Promise<boolean> {
  if (!personaId) return false
  const v = await getSetting(db, ENGINE_V2_KEY_PREFIX + personaId)
  if (v === 'fc') return true
  if (v === 'marker') return false
  return personaId === 'keeper'
}
