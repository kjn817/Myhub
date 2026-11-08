import { getSetting } from './ai-model-selection'

export const CLEF_ROUTER_MODE_KEY = 'clef.router_mode'

export type ClefRouterMode = 'off' | 'shadow' | 'active'

export async function getClefRouterMode(db: D1Database): Promise<ClefRouterMode> {
  const v = await getSetting(db, CLEF_ROUTER_MODE_KEY)
  return v === 'shadow' || v === 'active' ? v : 'off'
}
