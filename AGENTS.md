# Agent Handbook

This document collects the guardrails for anyone running autonomous or semi-automated tasks against this codebase.

## Core Repository Guidance

### Project Structure & Module Organization
- v3 is a cross-platform CS architecture. The client lives under `client/`: Vite + React 19 + React Router (`src/pages/`, `src/components/`, `src/lib/`, `src/types/`), with `src/platform/` as the single place where Tauri/Web differences are resolved (`isTauri`, `scanQr`, `tray`).
- `client/src-tauri/` is the Tauri 2 shell (Rust: tray menu, target-gated barcode plugin; icons; capabilities). `client/src-tauri/gen/` is generated and never committed; `client/scripts/android-patch.mjs` post-processes the generated Android manifest (cleartext + CAMERA + INTERNET).
- Real-time state is managed by the standalone Node service in `server/` (express + `ws` + `y-websocket` relay + multer for image uploads, CORS enabled for direct-IP clients). Collaboration is CRDT-based (Yjs) relayed over y-websocket — there is no Socket.IO or OT layer.
- v4 identity & storage: every device holds its own credential `poly_d_<uuid>_<48hex>` (secret generated client-side, server stores only sha256); recovery keys `poly_r_…` are shown once and regenerable. All state lives in one SQLite file `data/polyphony.db` (`node:sqlite`, 6 tables: accounts/devices/docs/memberships/attachments/doc_refs, doc snapshots as `state` BLOBs) — the server survives restarts. Docs have an explicit lifecycle (active → trashed 30d → purged); attachments live under `uploads/<code>/` and are recycled by reference count. Server modules split by domain (`auth.js`, `pairing.js`, `docStore.js`, `attachments.js`, `exporter.js`, `rooms.js`, `sweeper.js`, `routes/`); design docs: `docs/identity-and-sharing.md`, `docs/document-lifecycle.md`.
- Auth transport: HTTP uses `authFetch` (Bearer); WS credentials ride the `Sec-WebSocket-Protocol` subprotocol (`["polyphony.v1", "auth.<token>"]`), never the URL. Close codes 4001 (bad/revoked credential), 4004 (doc missing/purged), 4010 (doc trashed).
- v3 data is NOT migrated: on first boot `resetV3.js` archives legacy `accounts.json`/`uploads/` into `_v3-archive-<ts>/`. Merging v4 → main redeploys production and triggers the same reset there — treat the merge as the deliberate switch moment (with the `v4.0.0` tag).
- Server address is resolved at RUNTIME by `client/src/lib/serverConfig.ts` (`?server=` param > saved config > `VITE_SERVER_URL` dev-only > same-origin). Never inline server addresses at build time.
- QR payloads are Web URLs (`<server>/join?code=&server=` for docs, `<server>/pair?code=&server=` for device pairing) parsed by `lib/intake.ts` — any phone camera works as a fallback; in-app scanning goes through `platform/scanQr.ts` (native plugin on Android, jsQR+getUserMedia elsewhere; camera-less environments fall back to a paste form).
- Packaging runs entirely on GitHub Actions (`.github/workflows/build.yml`: web, desktop mac/win/linux, android). Local machines need no Rust/JDK — local work is `tsc`/`eslint`/`vite build` + convergence smoke only.
- Two-remote flow: `origin` is the private Gitea repo (day-to-day dev pushes; every push to main auto-deploys server+web via `.gitea/workflows/deploy.yml` on the self-hosted runner) and `github` is the public release repo (push `main` + `v*` tags only when releasing; all GitHub operations go through `gh`).
- Self-hosting is the all-in-one Docker image (`Dockerfile`/`docker-compose.yml`: web static + WS + API on one port; named volumes `polyphony-uploads` for images and `polyphony-data` for the SQLite store); `setup.sh` bootstraps local dev.
- `docs/` is the full handoff: architecture, the two v4 design docs (identity, doc lifecycle), collaboration internals, CI, deploy, testing, plus the decision log and gotcha inventory (`docs/decisions.md`). Consult it before re-deriving a design or re-debugging a known trap.

### Build, Test, and Development Commands
- Install dependencies with `npm install` in `client/` and `server/` (root package.json is an orchestrator only; `setup.sh` does both).
- Launch the UI via `npm run dev` (Vite :5173), start the collaboration service with `npm run server` (:3001), or run both together through `npm run dev:all`. For phone/App LAN debugging use `npm run dev:lan` (builds the web then serves web+API+WS on ONE port via `STATIC_DIR` — the printed `http://<LAN-IP>:<port>` works in phone browsers, the app, and desktop browsers alike; data in `server/data/`).
- Production web build is `client/dist/` (Vite). Self-hosting is the all-in-one Docker image (`docker compose up -d`, serves web + WS on one port); server+Web deploys are automated by the private Gitea CI (`.gitea/workflows/deploy.yml`). Desktop/android packages come from GitHub Actions releases, not local builds.
- `npm run lint` / `npm run build` delegate to `client/` (tsc --noEmit + eslint + vite build); `npm --prefix server test` runs the server unit suite (node:test, 44 tests).
- Tauri local dev (optional, needs Rust): `cd client && npx tauri dev`; Android: `npm run android:init` (init + manifest patch) then `npm run android:dev`.
- The legacy PM2/OpenResty deploy chain (`deploy/`, `ecosystem.config.js`) was removed in v3.1 — Docker all-in-one replaced it; see `docs/deploy-and-ops.md` and `docs/decisions.md` (#18).

### Coding Style & Naming Conventions
- Code in TypeScript and modern React. Respect the linting profile defined in `client/eslint.config.mjs` and keep indentation at two spaces.
- Use PascalCase for components and route groups, camelCase for hooks (`useCollaboration.ts`) and utilities, and UPPER_SNAKE_CASE only for environment variables.
- Keep Tailwind utility classes inline in JSX and reserve `index.css` for design tokens.
- Avoid mutating shared Yjs documents directly—go through the provider/hook in `client/src/lib/useCollaboration.ts` so CRDT updates are applied and broadcast correctly; route all Tauri-specific APIs through `client/src/platform/` instead of importing `@tauri-apps/*` from pages/components.
- The local checkout path must stay ASCII (`polyphony`): an em-dash path breaks Android Gradle builds.

### Testing Guidelines
- Server unit tests live next to their modules (`server/*.test.js`, node:test): auth/pairing state machines, doc lifecycle, attachment recycling, export. Run `npm --prefix server test`; add cases for every new server behavior. Tests must never log credentials, recovery keys, or full doc codes.
- Convergence smoke (`server/convergence-smoke.mjs`, start the server then run it) is REQUIRED after any change touching `useCollaboration.ts`, the Yjs document model, or the server relay: dual clients, 100 interleaved random-position inserts, deletion round, meta + awareness assertions, plus v4 gates (WS subprotocol auth, pairing both directions, doc lifecycle, attachments, export, health shape). Note: interleaved inserts split text markers — assert by bracket counts, never substring matching.
- E2E UI regression lives in `e2e/` (Playwright + system Chrome): run `cd e2e && npx playwright test` locally after touching `client/src/pages` or `client/src/components`, and add cases for new interactions. It is LOCAL-ONLY by design — never wire it into `.github/workflows/`; CI builds packages and nothing else. Two-user collaboration cases must use one browser context per user (same-context tabs skew y-websocket awareness attribution — see `e2e/README.md`).
- For collaboration flows, also script manual multi-client scenarios against the y-websocket server (`npm run server`, two editor tabs with the same room code).
- QR payload build/parse roundtrip is pure logic (`client/src/lib/qr.ts`) — verify with assertions after changes.

### Commit & Pull Request Guidelines
- Write small, imperative commits (e.g., `Add socket timeout guard`) that focus on a single change set.
- Reference related issues or tickets in the footer when applicable.
- Pull requests need a concise summary, testing evidence (commands and scenarios), and screenshots or GIFs for UI adjustments.
- Call out configuration or deployment impacts in a dedicated note and request reviews from both frontend and backend maintainers when changes span `client/` and `server/`.

## Agent Workflow & Tooling

### Shell Usage
- Run commands through `["bash","-lc", "<cmd>"]` and always set the `workdir` parameter instead of chaining `cd`.
- Prefer `rg`/`rg --files` for searches; fall back to alternatives only if `rg` is unavailable.
- Treat the filesystem as `workspace-write`: edit files inside the repo and request escalation before touching other paths.
- Network access is restricted; request approval only when it is essential to complete the task.

### Editing Practices
- Default to ASCII; introduce non-ASCII only when justified and consistent with the target file.
- Use `apply_patch` for single-file edits when practical; avoid it for generated content or large scripted changes.
- Preserve existing user modifications; never revert unrelated changes and pause if unexpected edits appear.
- Avoid destructive commands (`git reset --hard`, `git checkout --`, mass `rm`); execute them only when explicitly instructed.

### Planning & Execution
- Skip the planning tool for the simplest tasks (around the easiest 25%). Otherwise produce multi-step plans and update them as you complete steps.
- Execute at most one plan step at a time and keep the plan in sync with actual progress.
- Respect the `on-request` approval policy: supply `with_escalated_permissions` with a one-sentence justification whenever a command needs escalation.

### Testing & Validation
- Run meaningful checks locally when possible and summarize results instead of dumping logs.
- If tests cannot be run, note the limitation and outline how the user can verify the change.

### Communication & Responses
- Keep tone concise and collaborative; in reviews, lead with bugs and risks before summaries.
- Reference code with inline `path:line` notation and avoid URIs such as `file://`.
- Use inline backticks for commands or paths and fenced code blocks with language hints for snippets.
- In final responses, lead with the change explanation, follow with context, and provide next steps only when they are truly useful.

### Special Cases
- Fulfil simple user requests (e.g., showing the current time) via appropriate commands when feasible.
- For code reviews, adopt a bug-hunting mindset: prioritize risks, regressions, missing tests, and residual concerns.
- When approval or escalation is mandatory, request it directly through the tool call rather than via chat.
