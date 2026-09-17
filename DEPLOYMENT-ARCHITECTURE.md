# Deployment Architecture — from local CLI to shareable tool

> Design notes preserving a discussion on how to take `page-pair-diff` from a
> portable local CLI into something teammates can use, without turning it into a
> heavyweight cloud service. High-level on purpose — a memory of the decision,
> not a spec.

## The decision, in one line

**One web app. Three frames.** Build a thin server + web UI around the existing
engine; run that same server as a local desktop app *or* on a shared team box.
No rewrite between the two — only the shell around it changes.

## Why not the "big cloud service" route

A fully online, dynamically-autoscaling service (API + queue + worker autoscaling
+ object storage + managed DB + secrets + multi-tenant auth) is real work and real
ongoing cost. This tool is compute-heavy (headless Chromium via Playwright,
`sharp`/pixel diff, AI calls, long multi-page runs), so that route is genuinely
involved. We chose to keep compute local/self-hosted instead.

## Why not "everything runs in the browser tab"

A pure in-browser (sandboxed) app **cannot** do the three things this tool depends
on: (1) drive a real browser to crawl arbitrary third-party sites (same-origin /
CORS wall), (2) run native image libs, (3) write full result folders to disk. So
the work must run on a real machine (Node process), not inside a web page.

## The architecture: one engine, two run modes

```
        ENGINE (unchanged)  ── index.js + lib/  (crawl, diff, AI, run_* folders)
                │
        SERVICE LAYER (new, thin) ── web UI, in-process job queue,
                │                     serve results over HTTP, auth
        ┌───────┴────────┐
   binds localhost   binds network
        │                 │
   Tauri app / browser   Team server (shared, behind login)
```

- **Engine stays as-is.** Today: CSV of `source,target` → `processPair` per pair →
  `run_*` output folder. That becomes a callable function behind the service.
- **Service layer (the only new part):** a small Node HTTP server (Fastify/Express)
  that: serves a web UI (start a run from CSV/URLs, list past runs, open a run's
  existing review UI), runs jobs through a **lightweight in-process queue** (cap
  concurrency — Chromium is heavy), serves result artifacts over HTTP, stores runs
  on local disk.

## The three frames (identical UI in all of them)

1. **Tauri desktop app (local, polished):** the same server bound to `127.0.0.1`,
   shown in a native window. One user, their CPU/RAM, results on their disk. This
   is the streamlined version of today's portable model.
2. **Browser on localhost (local, dev/fallback):** the same server, opened in a
   normal browser tab. Free — costs nothing to leave this door open.
3. **Team server (shared):** the same server bound to the network, behind a login,
   on one shared box. Whole team points a browser at it; results are shared
   automatically because they live on that one server's disk.

## Desktop app vs. bare localhost — why wrap it

The UI is 100% shared (even the Tauri app is a webview of the same web app). A
native window is worth it because it: launches from a dock/Start-menu icon (no
terminal), owns the server lifecycle (starts on launch, stops on quit), picks its
own free port, gives native file dialogs + "reveal in Finder/Explorer" + OS
notifications, bundles Node + Chromium (zero user install), keeps UI/engine
versioned together, and (once code-signed) reads as real software instead of a
`localhost:12345 — Not Secure` page. Cost: per-OS packaging + code-signing
(Apple notarization ~$99/yr, a Windows cert) + a small static update feed.
**Tauri** preferred over Electron (smaller, lighter).

## What team mode realistically requires (much lighter than full cloud)

- **One box that stays on** — a Linux VM or spare office machine, ~4 vCPU /
  8–16 GB RAM is plenty for a team (sized by concurrent runs, not user count).
  Someone owns it (updates, backups).
- **Concurrency cap, not autoscaling** — a config knob ("max N runs at once");
  extras queue. In-process queue is enough; no SQS/Redis/K8s at team scale.
- **Login + HTTPS** — simplest path: put **Caddy** in front (auto-HTTPS + basic
  auth), and/or keep it on the internal network/VPN.
- **Results on disk, backed up** — the `run_*` folders on a volume; nightly backup.
- **AI keys:** team mode holds one shared key in the server env (add a spend cap
  if needed). Local mode can use bring-your-own-key (BYOK) for zero backend.

Not needed vs. the full-cloud route: managed queue, object storage, managed DB,
autoscaling, load balancers. Those only matter for unknown users at unpredictable
scale — a team server is a fixed, sized box (feature, not limitation).

## Build order (defer the hard/annoying parts)

1. **Service layer + web UI first.** Make a run invokable as a function; wrap it in
   the HTTP server + job queue + results browsing. This alone gives team mode *and*
   the localhost fallback for free, verifiable in any browser.
2. **Wrap in Tauri** for the polished local experience once the web UI is proven.
   Defer code-signing/packaging until then.
3. **Harden team mode** as needed: auth, concurrency tuning, backups, spend caps.

## Status (2026-09-16): path still undecided — but UI work can start now

The team hasn't yet chosen between this self-hosted route and the full cloud route
(decision expected next week). This does **not** block building the web UI: the UI
is common to both paths (start a run, watch progress, browse results); only the
backend behind it differs. We can build it now against a temporary local server and
re-point it at whichever backend wins.

To keep the UI fit for *either* path, hold to these rules:

- **Backend only via an HTTP API** — never assume direct filesystem/local access.
- **Runs are async jobs:** submit → `jobId` → poll/stream status → fetch results.
  (Cloud requires this; local can fake instant completion behind the same shape.
  A synchronous design now would break the cloud path — this is the assumption
  that matters most.)
- **Artifacts addressed by URL, not local path** (disk today, S3 tomorrow — UI
  doesn't care).
- **Leave an auth seam** — a pluggable "attach credentials" hook, no-op locally.
- **UI stays a static bundle** any host can serve (temp server / Tauri / CDN).

Temporary dev server: a tiny Node app that serves the static UI + implements the
job API against the engine. The API can be **stubbed first** (fake job ids/status,
a canned results folder) so front-end work proceeds in parallel with real engine
wiring.

## Open items / notes

- Confirm how cleanly a run detaches from CLI args/env flags into a `runJob(config)`
  function (env loaded from package dir today via `lib/load-env.js`; run folders are
  the durable artifact).
- Multi-page runs are heavy — the concurrency cap is the main knob protecting a
  shared box from thrash.
- No central results DB planned initially — the shared server's disk *is* the
  shared archive. A runs index/metadata store can come later if needed.
