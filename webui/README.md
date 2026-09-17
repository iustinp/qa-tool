# webui — temporary dev server + web UI (STUBBED backend)

Work-in-progress web UI for `page-pair-diff`, built so it fits **either** eventual
deployment path (self-hosted local/team server, or cloud). See the repo root
`DEPLOYMENT-ARCHITECTURE.md` for the decision context.

## Run it

```bash
node webui/server.js
# then open http://localhost:4321   (set WEBUI_PORT to change)
```

No dependencies — Node >= 18 only.

## What's real vs. stubbed

- **Real:** the web UI, and the job-shaped HTTP API *contract* the UI depends on
  (`POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/results`).
- **Stubbed:** the server fakes runs in memory and advances them on a timer; results
  and screenshots are canned. Nothing calls the real engine yet.

## The one seam that keeps it path-agnostic

`public/api.js` is the **only** place the UI talks to a backend. Everything is async
and job-shaped: `submit -> jobId -> poll status -> results`. To go live, replace the
stub handlers in `server.js` with real ones that call the engine's `runJob(config)`
(and wire `attachAuth` in `api.js` for team/cloud auth). **No UI code changes.**

## Design rules (don't break these — they're what make it fit both paths)

- Backend only via the HTTP API; never assume local filesystem access from the UI.
- Runs are always async jobs (no synchronous "run and wait").
- Artifacts addressed by URL, not local path (disk today, object storage tomorrow).
- Keep an auth seam (`attachAuth`), a no-op locally.
- UI stays a static bundle any host can serve (this server / Tauri / a CDN).
