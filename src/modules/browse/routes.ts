/**
 * 브라우저 모듈 — 원격 실제 브라우저(Browser Run) 세션 발급 라우트.
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { registerLiveRoutes } from './live'

export const browseApp = new Hono<{ Bindings: Env }>()
registerLiveRoutes(browseApp)
