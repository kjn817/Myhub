/**
 * OAuth Provider v1 POC — 인증 서버 Worker.
 *
 * 공식 예제(examples/split-workers/auth-server)를 MyHub 식별자에 맞게 옮긴 것이다.
 * `OAuthAuthorizationServer`가 토큰·grant·클라이언트 저장을 KV(OAUTH_KV)에 맡고,
 * 이 파일은 /authorize 라우트만 소유한다.
 *
 * ⚠️ POC 전용: /authorize는 고정 테스트 사용자로 자동 승인한다.
 * 실제 PIN 로그인·동의 페이지가 없어, 도달 가능한 Worker에 이대로 배포하면
 * 누구나 테스트 사용자 토큰을 발급받을 수 있다. 운영 wiring은
 * docs/oauth-provider-v1-design-20261028.md §3을 볼 것.
 * 이 Worker는 로컬 workerd 하네스에서만 돌린다.
 */

import {
  AuthorizationError,
  OAuthAuthorizationServer,
  type AuthRequest,
} from '@cloudflare/workers-oauth-provider'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { MCP_RESOURCE, OAUTH_ISSUER, SCOPES_SUPPORTED } from '../common'

interface Env {
  OAUTH_KV: KVNamespace
}

/** POC 테스트 사용자 — 실제 이메일·자격 증명이 아니다. */
export const POC_USER = { id: 'poc-user', email: 'poc-user@myhub.local' }

export const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: OAUTH_ISSUER,
  resources: [MCP_RESOURCE],
  scopesSupported: SCOPES_SUPPORTED,
  // 구형 클라이언트 호환용 동적 클라이언트 등록 (MCP 2026-07-28은 CIMD 우선이나,
  // POC는 공식 e2e와 같은 DCR 경로로 검증한다).
  clientRegistrationEndpoint: '/oauth/register',
})

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env)
  let oauthRequest: AuthRequest
  try {
    oauthRequest = await oauth.parseAuthRequest(request)
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302)
    return new Response(error.description, { status: 400 })
  }

  const client = await oauth.lookupClient(oauthRequest.clientId)
  if (!client) return new Response('Unknown OAuth client', { status: 400 })

  // POC: 로그인·동의 없이 자동 승인. 운영에서는 PIN 로그인 + 동의 페이지로 교체한다.
  const { redirectTo } = await oauth.completeAuthorization({
    request: oauthRequest,
    userId: POC_USER.id,
    metadata: { clientName: client.clientName, email: POC_USER.email },
    scope: oauthRequest.scope.filter((scope) => SCOPES_SUPPORTED.includes(scope)),
    props: { userId: POC_USER.id, email: POC_USER.email },
  })
  return Response.redirect(redirectTo, 302)
}

export default class AuthServer extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    if (new URL(request.url).pathname === '/authorize') {
      return authorize(request, this.env)
    }
    return authorizationServer.fetch(request, this.env, this.ctx)
  }

  /** 리소스 Worker가 Service Binding으로 부르는 토큰 검증 진입점. */
  validateToken(resource: string, token: string) {
    return authorizationServer.validateToken(resource, token, this.env)
  }
}
