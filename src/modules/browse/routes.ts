/**
 * 브라우저 모듈 결선 (src/modules/browse/routes.ts).
 *
 * Oracle 원격 브라우저 프록시만 노출한다 (2026-11-14 설계 변경으로
 * Cloudflare Browser Run 세션 발급은 폐기). 인증은 전역 /api/*
 * 미들웨어가 맡는다.
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { registerOracleProxyRoutes } from './oracle-proxy'

export const browseApp = new Hono<{ Bindings: Env }>()

registerOracleProxyRoutes(browseApp)
