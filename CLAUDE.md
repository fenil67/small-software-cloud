# CLAUDE.md — Utir (repo: small-software-cloud)

Read this whole file before doing anything. It is the source of truth for how to work in this repo.
Update the "Current state" section at the end of every piece of work (see "Keeping this file current").

## What this is

Utir turns an app built by you or your AI into a live, private web app. Users deploy with the CLI
(`npx @utir/ssc deploy .`) or the MCP server; each app runs on Fly Machines behind our auth proxy, and
only people the owner shared it with can open it. Product name in all user-facing text is **Utir**
(never "Small Software Cloud", never invented names or domains).

- Dashboard: https://app.utir.dev  ·  API: https://api.utir.dev  ·  login hop: https://app.utir.dev/access
- Customer apps live on `*.fly.dev` (later `utir.si`). NEVER host customer apps under `utir.dev` (Clerk cookies live there).
- Planning and status: Notion "Handoff - read this first (Small Software Cloud)" and its "Utir — Work Board".

## Repo layout (absolute root: /Users/fenilpatel/dev/small-software-cloud)

| Path | What | Notes |
|---|---|---|
| `apps/api` | Express API (TypeScript) | **npm** + `apps/api/package-lock.json`; Docker build on Railway |
| `apps/api/src/routes` | HTTP routes | apps, appAccess, apiKeys, proxy, me, workspace, admin, activityAdmin, webhooks, intake, deployments, deployStream, health |
| `apps/api/src/lib` | core logic | appUrl (ONE app-URL normalizer), clerkSync, workspaceDelete, userDelete, reconcile, activityLog, watchdog, reaper, flyMetrics, flyNetwork, githubUrl, zipValidate, childEnv, safeErr, dbGuard, email/ |
| `apps/api/migrations` | SQL migrations 001…016 | run automatically on deploy (preDeployCommand) |
| `apps/api/scripts` | `run-suite.sh`, `run-tests.ts`, `test-server.ts`, `fixtures/` | test-only code lives ONLY here |
| `apps/api/src/scripts` | one-off ops scripts (e.g. `reconcile-deleted-orgs.ts`) | dry run by default |
| `apps/web` | Next.js 16 dashboard | **pnpm**; read `apps/web/AGENTS.md` (Next 16 differs from training data) |
| `apps/web/app/(auth)` | custom sign-in / sign-up / sso-callback / accept-invite | built on Clerk APIs, not Clerk UI |
| `apps/web/app/(dashboard)` | apps, app detail, keys, settings, admin | |
| `apps/web/app/(onboarding)` | create first workspace | `?new=1` for additional ones |
| `apps/web/lib` | api client + type guards, theme, safe-redirect, navigate (navigateHard), app-url, activity-events | |
| `apps/web/components` | dashboard, auth, brand, theme | reuse these; do not add a UI library |
| `apps/proxy` | per-app auth proxy (no runtime deps) | image published with `apps/proxy/scripts/publish.sh <tag>`; never reuse a tag |
| `packages/cli` | `@utir/ssc` (command `ssc`) | publish ONLY via `scripts/publish-npm.sh` |
| `packages/mcp` | `@utir/ssc-mcp` | same |
| `packages/client` | shared client | |
| `docs/design/*/*.dc.html` | approved screen designs (dark + light) | match exactly; no new designs |
| `docs/security/dependency-decisions.md` | accepted dependency findings | |

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| Git branch | feature branch | `staging` | `main` |
| Web / API | localhost | https://staging-app.utir.dev / https://staging-api.utir.dev | https://app.utir.dev / https://api.utir.dev |
| Database | Docker Postgres 18.6 `ssc-pg18-test` on 127.0.0.1:5433, db `ssc_test` | Railway env "staging" Postgres | Railway env "production" Postgres |
| Clerk | development instance | development instance | production instance |
| Fly org | — | `utir-staging` (proxy image copy: `ssc-proxy-image-staging`) | `personal` (proxy image: `ssc-proxy-image`) |
| Email (Resend) | off | off (no RESEND_API_KEY) | on, from notifications@mail.utir.dev |
| Alerts | — | Discord #staging | Discord alerts channel |

Railway: no config files (Config as Code ended 2026-12-01; `railway.toml` was removed 2026-11-23). Settings live in each
environment's service settings and must match in staging and production (only the branch differs): api Root Directory
`/apps/api`, Dockerfile builder, start `node dist/index.js`, pre-deploy `node dist/db/migrate.js` (migrations), health
check `/health` timeout 120 (checks the DB and gates deploys), restart on failure max 3; branch `staging` / `main`.
Change a setting in staging first, then production. Check with `railway config migrate status`. Web service has no root directory,
builds from repo root with Railpack (Node 20, pnpm 9, `pnpm install --frozen-lockfile`, `pnpm --filter web build`).

## How every change ships (no exceptions)

1. Claude Code works on a feature branch (`fix/...`, `feat/...`) created from up-to-date `main`.
2. Claude Code runs the full gate and reports it with counts. **Claude Code never commits, pushes, deploys or calls production.**
3. Fenil reviews, commits, pushes the feature branch, merges it into `staging`; Railway deploys staging.
4. Fenil tests on staging. Bugs go back to the same feature branch → staging again.
5. Only when staging is clean: merge `staging` into `main` (fast-forward). Railway deploys production.

## The gate (run all, report each with counts)

```
pnpm --filter web build
pnpm --filter web exec vitest run          # web tests (count must go up when web code changes)
bash apps/api/scripts/run-suite.sh         # API suite on Postgres 18.6 in Docker, must print Failed: 0
pnpm --filter web exec tsc --noEmit --incremental false
cd apps/api && npx tsc --noEmit --incremental false
pnpm --filter web lint                      # --max-warnings 0
ls **/*.bak                                 # must be none
git status                                  # only files for this task
```

- Run ONE suite at a time, in the foreground. Never start suites in the background or in parallel (they fight over port 4099).
- If the suite hangs, check `docker info` first; a hung Docker Desktop stalls everything.
- Local `tsc` with incremental can hide errors; always use `--incremental false`. The production web build also type-checks test files.

## Strict rules

**Git and deploys**
- Never commit, push, merge, deploy, publish to npm, or call production/staging APIs. Fenil does all of that.
- Never run `git checkout`, `git restore`, `git stash` or `git reset` on uncommitted work. To undo a temporary change, use the `.bak` copy.
- Confirm the branch with `git branch --show-current` before editing.
- Never edit or rename a migration that has run. New migration = next number. Say in the report if it rewrites data or takes long locks.
- After any `package.json` change run `pnpm install --lockfile-only` at the repo root (Railway uses a frozen lockfile).

**Security (Utir runs other people's code; a mistake is a breach)**
- Every security guard gets a test that fails when the guard is removed. Prove it with a mutation using the `.bak` method: copy the file to `.bak`, apply the mutation, run the suite once and SHOW the failing output, restore from `.bak`, delete the `.bak`. A mutation that leaves the suite green means a missing test.
- Org isolation: another org's resource returns 404, never 403 or data. Destructive and sharing actions need `org:admin` (Clerk session) or the `manage` key scope.
- Platform admin = Clerk ids in `PLATFORM_ADMIN_CLERK_IDS`; Clerk sessions only, API keys are never admin; admin routes return 404 to everyone else.
- The proxy fails closed. Apps without the proxy signature get suspended by the watchdog. Egress policy (DNS, 80, 443) is set before the first Machine.
- Never print, log, commit or paste secrets (keys, tokens, webhook URLs, DATABASE_URL). Do not read `.env` files. Logs carry error codes, not emails or names.
- Do not invent URLs, domains or package names. Shipped URLs are limited to api.utir.dev and app.utir.dev (tests enforce this).
- App URLs: `apps.subdomain` stores the full URL; always go through `apps/api/src/lib/appUrl.ts` (API) or `apps/web/lib/app-url.ts` (web). Never prefix `https://` yourself.
- Destructive decisions based on Clerk: only Clerk's explicit 404 `resource_not_found` means "deleted". Any other status, timeout or network error is an error; never delete on it.
- Test-only endpoints and shims exist ONLY in `apps/api/scripts/test-server.ts`, never under `apps/api/src`.
- Activity log (`activity_events`) is append-only and kept forever; only the erase-a-person path may remove data.

**Frontend**
- Match `docs/design` exactly, in dark, light and system modes (cookie `utir-theme`, CSS variables, Geist font). No new designs, no UI libraries.
- No Clerk prebuilt components except `AuthenticateWithRedirectCallback`. Use Clerk v7 APIs (`signIn.emailCode`, `signIn.sso`, `finalize`, reverification for sensitive actions). Check exact APIs in `node_modules` type definitions; never guess.
- After `setActive` that changes or loses the active workspace, navigate with `navigateHard` (Clerk's `redirectUrl` path can hang or get cancelled).
- Show plain error messages, never raw Clerk or server text. Guard API responses with the type guards in `apps/web/lib/api.ts`; contract fixtures come from the API suite.

**Reporting**
- Report root cause first, then the fix, then the gate table with counts, then each mutation with its failing output.
- Never claim tests passed that you did not run in this session. If something was not done, say so.
- Do not touch files unrelated to the task (see Working principles).

## Working principles (adapted from forrestchang/andrej-karpathy-skills, MIT, inspired by Andrej Karpathy)

1. **Think before coding.** State assumptions. If something is ambiguous, list the interpretations and ask instead of picking silently. If a simpler approach exists, say so. When confused, stop and name what is unclear.
2. **Simplicity first.** Minimum code that solves the asked problem. No speculative features, no abstractions for single use, no configurability nobody asked for. If 200 lines could be 50, rewrite it.
3. **Surgical changes.** Touch only what the task needs. Match existing style. Do not "improve" or refactor neighbouring code; mention unrelated problems instead of fixing them. Remove only what your own change made unused. Every changed line should trace back to the request.
4. **Goal-driven execution.** Turn the task into checkable goals ("fix the bug" → "write a test that reproduces it, make it pass"). State a short plan with a check for each step, and loop until every check passes.

## Useful commands

- Free port 4099: `for p in $(lsof -nP -tiTCP:4099 -sTCP:LISTEN); do ps -p $p -o command= | grep -q test-server && kill $p; done`
- Ops scripts run inside the Railway container (no secrets on the Mac): `railway ssh --service api --environment <staging|production>` then `node dist/scripts/<script>.js` (dry run first). The image has no curl; use `node -e` with fetch.
- Staging test deploy without touching the production CLI login: `read -s "SSC_API_KEY?key: "; export SSC_API_KEY; export SSC_API_URL=https://staging-api.utir.dev; npx @utir/ssc deploy . --name <name>; unset SSC_API_KEY SSC_API_URL`
- New proxy image: publish with `apps/proxy/scripts/publish.sh <tag>`, then copy the same digest to staging with `crane copy registry.fly.io/ssc-proxy-image@sha256:<d> registry.fly.io/ssc-proxy-image-staging:<tag>`; update `PROXY_IMAGE` in both Railway environments.

## Known gotchas

- Next.js 16: `proxy.ts` replaces `middleware.ts`; `cookies()` is async.
- Clerk's ClerkProvider calls `router.refresh()` after every `setActive`. If the current URL has Clerk ticket params, that re-fetch triggers a Clerk handshake redirect → RSC fetch fails → full reload → loop. Always call `history.replaceState` to strip ticket params BEFORE calling `setActive`. Use `setActive({ organization, redirectUrl: "/apps" })` for normal switches and `navigateHard` after deletions.
- Clerk membership lists are paginated (default 10); always page. `getOrganizationMemberships` uses `pageSize`/`initialPage` (ClerkPaginationParams) and returns `total_count` (not `totalCount`).
- A used invitation link arrives at `/accept-invite` as `?__clerk_status=sign_in&org=<orgId>` with NO `__clerk_ticket` — FAPI consumed the ticket and redirected back. `TicketStatus` values are `sign_in | sign_up | complete`. The `!ticket + clerkStatus` branch in `page.tsx` handles this.
- `DashboardShell` reads `?org=` on mount to verify/switch the active org after a fresh accept-invite flow. Guard: `org-activate-v1:<orgId>` sessionStorage key prevents loops when `navigateHard("/apps")` re-renders the shell.
- flyctl in the API image is pinned (0.5.1); deploy args stay `deploy --remote-only --ha=false --app <name> --yes` with CI=true.
- Fly images are private per org (that is why staging has its own proxy image copy).
- Watchdog Discord alert `metrics_unavailable ETIMEDOUT` = Fly Prometheus was slow; act only if it persists.
- Railway deploy settings are in the dashboard, not the repo. If migrations stop running, check the api pre-deploy command first.
- Fly org token for Railway expires 2027-02-09: renew before then.
- Fly Machine Update API is `POST /v1/apps/{app}/machines/{id}` — not PUT. PUT returns 404.
- Fly test stubs must mirror Fly's documented methods and paths; a stub that accepts anything hides real 404s. Use `FLY_API_BASE=http://localhost:${_testPort}` in test-server.ts and add HTTP routes for each Fly path so the wrong method is rejected by the stub, not silently accepted.

## Current state (update at the end of every task)

- Last updated: 2026-11-28. Tests: API 1391, web 437.
- Live: auth (Google, GitHub, email code), workspaces (create, switch, delete with full cleanup), apps, sharing with invite emails, API keys with scopes, account settings (profile, emails, connected accounts, sessions, reverification, delete account), admin overview and activity, kill switch, watchdog, staging environment. Workspace members and roles (feat/workspace-members, merged to staging). UI polish (feat/ui-polish, merged to staging). Build logs (feat/app-logs, merged to staging). Environment variables (feat/app-env, merged to staging).
- Branch fix/unique-workspace-names: `OnboardingClient.handleCreate` calls `checkDuplicateName` (paged `getOrganizationMemberships`, `pageSize`/`initialPage`/`total_count`) before `createOrganization`. Duplicate (trimmed, case-insensitive) → "You already have a workspace with this name." error; membership load failure → "Could not load your workspaces." error. No other create/rename path exists in app code (confirmed: `createOrganization` only in `OnboardingClient`; `updateOrganization` only in Clerk node_modules). Tests: 5 new (exact match, different case + spaces, page-2 duplicate, unique name proceeds, membership fail). Mutation: remove duplicate check → 4 tests fail.
- Repo search: `createOrganization` in app source: only `apps/web/app/(onboarding)/onboarding/OnboardingClient.tsx`. `updateOrganization`/rename: not present in app source.
- Next (see Notion Work Board): admin users/workspaces/apps → utir.dev landing, Privacy, Terms, Docs → weeks 5-6 security (CI scans, integration suite in CI, internal red team) → closed beta.
- Open: book the external pen test.

## Keeping this file current

At the end of every task, in the same feature branch, update "Current state" (date, what changed, test counts, what is next) and any section the task made wrong (new paths, new rules, new gotchas). Keep it short; history belongs in Notion, not here.
