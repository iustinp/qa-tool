# webui — temporary dev server + web UI (STUBBED backend)

Work-in-progress web UI for `page-pair-diff`, built so it fits **either** eventual
deployment path (self-hosted local/team server, or cloud). See the repo root
`DEPLOYMENT-ARCHITECTURE.md` for the decision context.

## Run it

```bash
node webui/server.js
# then open http://localhost:4321
```

Node >= 18. Uses `sharp` (an existing project dependency) to generate small
screenshot thumbnails for the results panel; no other dependencies.

### Env knobs

- `WEBUI_PORT` — port (default `4321`).
- `WEBUI_ENGINE` — `real` (default) runs the actual engine; `stub` fakes runs in
  memory (no engine, no cost) for UI-only work / demos.
- `WEBUI_MAX_CONCURRENT` — max simultaneous runs (default `2`). Chromium is heavy;
  extra runs queue. This is the "team server" concurrency knob.

## How the real backend works

`POST /api/runs` writes the pasted/uploaded pairs to a CSV and spawns the existing
engine — `node index.js --csv <csv> --out <runDir> [mode flag]` — as a child process
per job. Progress is parsed from the engine's `[i/N]` stdout lines. When it exits,
the run folder (`report.html`, `CUSTOMER-Report.html`, per-pair
`pairs/<slug>/layout-review.html`, screenshots) is served under
`/api/runs/:id/files/...`, and `GET /api/runs/:id/results` returns a normalized
summary read from the engine's `summary.json`.

Run folders live under `webui/runs/` (gitignored).

**Modes** (from the UI dropdown): `full` (screening + AI), `text-only` (no AI),
`screening-only` (no AI). The two no-AI modes are cheap and good for smoke tests.

## The one seam that keeps it path-agnostic

`public/api.js` is the **only** place the UI talks to a backend. Everything is async
and job-shaped: `submit -> jobId -> poll status -> results`. The engine is invoked as
a child process today; swapping that for a cloud API + queue means changing only
`server.js` (and wiring `attachAuth` in `api.js` for team/cloud auth). **No UI code
changes.**

## Design rules (don't break these — they're what make it fit both paths)

- Backend only via the HTTP API; never assume local filesystem access from the UI.
- Runs are always async jobs (no synchronous "run and wait").
- Artifacts addressed by URL, not local path (disk today, object storage tomorrow).
- Keep an auth seam (`attachAuth`), a no-op locally.
- UI stays a static bundle any host can serve (this server / Tauri / a CDN).
