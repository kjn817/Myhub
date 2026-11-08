import type { PersonaId, RouteResult } from './router';

/** Transitional contract only. Reconcile with the real orchestrator.ts first. */
export interface RouterDecision {
  primary: PersonaId;
  collaborator?: PersonaId;
  reason: string;
  confidence?: number;
}

/** Null requires the caller to request selection; never invent a primary. */
export function toLegacyRouterDecision(route: RouteResult): RouterDecision | null {
  if (!route.persona) return null;
  return {
    primary: route.persona,
    reason: route.reason,
    ...(route.confidence === undefined ? {} : { confidence: route.confidence }),
  };
}
