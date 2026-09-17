/**
 * The ONLY place the UI talks to a backend.
 *
 * Everything is job-shaped and async: submit -> jobId -> poll status -> results.
 * Swapping this stub backend for the real self-hosted or cloud API means changing
 * only the fetch calls below (and `attachAuth`) — no UI code changes.
 *
 * Keep this contract stable:
 *   createRun({ label, csv })      -> { jobId, status }
 *   listRuns()                     -> { runs: [...] }
 *   getRun(jobId)                  -> { id, status, stage, progress, ... }
 *   getResults(jobId)             -> { runId, pairs: [...] }
 */
const API = (() => {
  const BASE = ''; // same-origin today; a cloud API base URL can slot in here.

  // Auth seam: no-op locally, becomes a token/cookie attach in team/cloud mode.
  function attachAuth(headers = {}) {
    return headers;
  }

  async function request(path, options = {}) {
    const res = await fetch(BASE + path, {
      ...options,
      headers: attachAuth({
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      }),
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const body = isJson ? await res.json() : null;
    if (!res.ok) {
      const message = (body && body.error) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return body;
  }

  return {
    health: () => request('/api/health'),
    createRun: ({ label, csv, mode, threads, recipe, resolutions, ignoreSource, ignoreTarget, clickSource, clickTarget }) =>
      request('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ label, csv, mode, threads, recipe, resolutions, ignoreSource, ignoreTarget, clickSource, clickTarget }),
      }),
    listRuns: () => request('/api/runs'),
    getRun: (jobId) => request(`/api/runs/${jobId}`),
    getResults: (jobId) => request(`/api/runs/${jobId}/results`),
    deleteRun: (jobId) => request(`/api/runs/${jobId}`, { method: 'DELETE' }),
    listRecipes: () => request('/api/recipes'),
    saveRecipe: (recipe) =>
      request('/api/recipes', { method: 'POST', body: JSON.stringify(recipe) }),
    // (recipe payload already includes resolutions when present)
    deleteRecipe: (name) =>
      request(`/api/recipes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  };
})();
