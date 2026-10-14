# Soot source deployments

Read installed `docs/soot.md` for the native source/C1/C3 contract. Resolve the
installed product root with this skill's `scripts/product-root.ts`. Use a named
App, exact Linux image/receipt and already materialized offline bundle. A producer
receipt for a local OCI is not proof that the registry contains the image.

1. Run offline `validate -f FILE`, resolve app-scoped VM secrets, and inspect a
   read-only `plan -f FILE --plan-output PRIVATE_FILE`. Plans create no remote
   stage, source write, VM revision, certificate or C3 lease.
2. First bootstrap is an explicit create-only management phase. Review the exact
   server/instance/control/image/source/receipt facts before setting
   `reviewed_initialization: true`. Apply only that artifact, then plan again.
3. Show the safe source scope/digest and all C3 bindings to the operator. Initial
   source needs `initial_source_review`; saved/active edits since D need
   `reviewed_replacement`. The decision repeats all `plan.bindings` exactly.
   Do not populate either acknowledgment merely because apply was requested.
   Never print mission contents, tokens, vault values or full runtime config.
4. Apply with `--plan-file PRIVATE_FILE --apply`. Changed source, receipt,
   control revision, P/A/F or staging bytes requires abort/replan/review. A bare
   apply or refreshed expected revision does not approve operator edits.
5. Verify acknowledged runtime/source/package, readiness and declared public
   HTTPS/auth before reporting success. Separate provider smoke from readiness.

Bare runtime + per-repository Soots: omit `spec.bundle` from the App (plan
reports `initialize`, `none` or a package-only `upgrade`), let the operator add
providers in Nest, and deploy each repository's slice with a `kind: SootSource`
document (`spec.runtime`, `spec.bundle`, optional `spec.source`), created with
`2srv init soot-source ID --runtime APP -o DIR/deploy.yaml` beside the bundle.
`2srv deploy -f DIR/deploy.yaml --apply` deploys in one step when the decision is
`none` (unchanged slice) or `safe` (first deploy into an empty slice). A
`replace` decision (Nest edits, or files never deployed from the repo) asks for
the source id on a terminal and is refused non-interactively: report it to the
operator and pass `--replace-edits` only on their explicit decision. A source deploy never
touches providers, other sources or the release pointer; a runtime with sources
refuses a complete bundle deploy (`sources_present`).

Use `app NAME release-status`, `restart --apply` and `restore-release` from
`app NAME help`. Restart uses installed acknowledged config, never release
defaults. Guarded restore is plan by default; review the exact request and set
`reviewed_restore: true`, then use `--plan-file FILE --apply`. Missing/incompatible
prior code, edits, unreadable sources or unsafe abort are blockers to inspect.
Do not refresh/replay an uncertain POST with a new request ID. Reconcile the
existing sanitized transaction and retained lease first.
Pre-commit handoff failures recover the retained supervisor before aborting the
same lease. If close or recovery is blocked, preserve the fence and inspect the
reported request; do not force a second store owner.

Preserve fixed config/transactions/state/credentials mounts and all data/vault/
history/receipts/monitoring. Wait for old process exit before another opens its
bbolt stores. A stop/join timeout forbids replacement. Retire domains explicitly
before process removal; preserve retained storage. Control backup excludes these
databases. Never copy an open database as backup or reset an incomplete instance.
