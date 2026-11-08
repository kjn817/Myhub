# Needs Validation — run-001

No unresolved records. All 7 candidates from the hunter reached an
independent `confirmed` disposition (one was proposed `needs_validation`
by the hunter — `auth/login-page-cdn-no-sri` — and was promoted to
`confirmed` by two independent verifiers after source checks established
the control gap itself).

## Open leads for later runs

- `src/index.ts` auth middleware is `out_of_scope` in this pilot run
  (1 ledger unit). A later run should cover it — it is the gate that
  enforces sessions on all protected routes and sets response headers.
- The three race findings were reproduced against mock D1/KV with
  modeled latency. The actual burst ceiling on production Workers/D1 was
  not measured (production access is forbidden for audits); the code-level
  race is established, the production timing window is not.
- Whether unpkg is an approved trusted dependency is not recorded in
  source; the CDN finding does not depend on that policy fact.
