/* UI logic. Knows nothing about the backend beyond the API contract in api.js. */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    modeBadge: $('#modeBadge'),
    label: $('#labelInput'),
    pairs: $('#pairsInput'),
    modeSelect: $('#modeSelect'),
    threads: $('#threadsInput'),
    recipeSelect: $('#recipeSelect'),
    saveRecipeBtn: $('#saveRecipeBtn'),
    deleteRecipeBtn: $('#deleteRecipeBtn'),
    ignoreSource: $('#ignoreSource'),
    ignoreTarget: $('#ignoreTarget'),
    clickSource: $('#clickSource'),
    clickTarget: $('#clickTarget'),
    browseBtn: $('#browseBtn'),
    csvFile: $('#csvFile'),
    startBtn: $('#startBtn'),
    startMsg: $('#startMsg'),
    refreshBtn: $('#refreshBtn'),
    siteFilter: $('#siteFilter'),
    runsList: $('#runsList'),
    results: $('#results'),
    resultsTitle: $('#resultsTitle'),
    resultsBody: $('#resultsBody'),
    closeResults: $('#closeResults'),
  };

  // Jobs we are actively polling: jobId -> intervalId
  const polling = new Map();

  // Multi-select site filter (empty set = show all). The full run set is cached so
  // toggling the filter re-renders without refetching.
  const siteFilter = new Set();
  let allRuns = [];
  const RUNS_PAGE = 10;
  let runsLimit = RUNS_PAGE; // cap the visible run history; "Load more" grows it

  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  }
  // Source host of the first real pair in the pairs box (a run/recipe's site).
  function currentSite() {
    for (const line of els.pairs.value.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const src = t.split(/[;,]/)[0].trim();
      if (/^source/i.test(src)) continue;
      return hostOf(src);
    }
    return null;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString();
  }

  function statusClass(status) {
    if (status === 'done') return 'ok';
    if (status === 'error') return 'err';
    if (status === 'running') return 'run';
    return 'queued';
  }

  // Config chips showing how a run was configured (Mode + ignore/click counts).
  // The actual selectors appear on hover so past runs stay understandable.
  function runConfigChips(r) {
    const cnt = (a) => (Array.isArray(a) ? a.length : 0);
    const chips = [`<span class="chip">${escapeHtml(r.mode || 'full')}</span>`];
    if (r.threads > 1) chips.push(`<span class="chip">${r.threads} threads</span>`);
    if (r.recipe) chips.push(`<span class="chip" title="Site recipe used">▦ ${escapeHtml(r.recipe)}</span>`);
    const titleFor = (label, s, t) => {
      const parts = [];
      if (cnt(s)) parts.push(`source:\n  ${s.join('\n  ')}`);
      if (cnt(t)) parts.push(`target:\n  ${t.join('\n  ')}`);
      return `${label}\n${parts.join('\n')}`;
    };
    if (cnt(r.ignoreSource) || cnt(r.ignoreTarget)) {
      chips.push(
        `<span class="chip" title="${escapeHtml(titleFor('Ignored', r.ignoreSource, r.ignoreTarget))}">ignore ${cnt(r.ignoreSource)}/${cnt(r.ignoreTarget)}</span>`
      );
    }
    if (cnt(r.clickSource) || cnt(r.clickTarget)) {
      chips.push(
        `<span class="chip" title="${escapeHtml(titleFor('Clicked', r.clickSource, r.clickTarget))}">click ${cnt(r.clickSource)}/${cnt(r.clickTarget)}</span>`
      );
    }
    return chips.join('');
  }

  // --- Searchable multi-select site dropdown (scales to many sites) -----------
  // Selected sites pin above a separator; the searchable list of the rest sits
  // below, so you can keep searching and adding. Built once; only its lists and
  // the trigger label update on refresh (never rebuilt, to survive 1.2s polling).
  let siteDropdownBuilt = false;
  let lastSitesSig = '';
  const sitesFromRuns = () => [...new Set(allRuns.map((r) => r.site).filter(Boolean))].sort();

  function buildSiteDropdown() {
    els.siteFilter.innerHTML =
      '<button type="button" class="ms-trigger" id="msTrigger">All sites ▾</button>' +
      '<div class="ms-panel" id="msPanel" hidden>' +
      '<input type="text" class="ms-search" id="msSearch" placeholder="Search sites…" autocomplete="off" />' +
      '<div class="ms-selected" id="msSelected"></div>' +
      '<hr class="ms-sep" id="msSep" />' +
      '<div class="ms-options" id="msOptions"></div>' +
      '</div>';
    const panel = els.siteFilter.querySelector('#msPanel');
    const search = els.siteFilter.querySelector('#msSearch');
    els.siteFilter.querySelector('#msTrigger').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      if (willOpen) {
        search.value = '';
        renderDropdownLists();
        search.focus();
      }
    });
    search.addEventListener('input', renderDropdownLists);
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      panel.hidden = true;
    });
    siteDropdownBuilt = true;
  }

  function updateTriggerLabel() {
    const trigger = els.siteFilter.querySelector('#msTrigger');
    if (!trigger) return;
    const n = siteFilter.size;
    trigger.textContent = `${n === 0 ? 'All sites' : n === 1 ? [...siteFilter][0] : `${n} sites`} ▾`;
  }

  function renderDropdownLists() {
    const selectedEl = els.siteFilter.querySelector('#msSelected');
    const optionsEl = els.siteFilter.querySelector('#msOptions');
    const search = els.siteFilter.querySelector('#msSearch');
    if (!selectedEl || !optionsEl) return;
    const q = (search.value || '').trim().toLowerCase();
    const sites = sitesFromRuns();
    const selected = [...siteFilter].filter((s) => sites.includes(s)).sort();
    const options = sites.filter((s) => !siteFilter.has(s) && s.toLowerCase().includes(q));
    const row = (s, on) =>
      `<button type="button" class="ms-opt${on ? ' on' : ''}" data-site="${escapeHtml(s)}">` +
      `<span class="ms-box">${on ? '✓' : ''}</span><span class="ms-name">${escapeHtml(s)}</span></button>`;
    selectedEl.innerHTML = selected.length
      ? selected.map((s) => row(s, true)).join('') +
        '<button type="button" class="ms-clear" id="msClear">Clear all</button>'
      : '<div class="ms-empty">Showing all sites</div>';
    optionsEl.innerHTML = options.length
      ? options.map((s) => row(s, false)).join('')
      : '<div class="ms-empty">No matches</div>';
    els.siteFilter.querySelectorAll('.ms-opt').forEach((b) =>
      b.addEventListener('click', () => {
        const s = b.dataset.site;
        if (siteFilter.has(s)) siteFilter.delete(s);
        else siteFilter.add(s);
        runsLimit = RUNS_PAGE; // a new filter view starts from the top
        renderDropdownLists();
        updateTriggerLabel();
        renderRunsList();
        search.focus();
      })
    );
    const clear = els.siteFilter.querySelector('#msClear');
    if (clear)
      clear.addEventListener('click', () => {
        siteFilter.clear();
        runsLimit = RUNS_PAGE;
        renderDropdownLists();
        updateTriggerLabel();
        renderRunsList();
        search.focus();
      });
  }

  // Data/dropdown sync — runs on every refresh (incl. polling). Cheap: never
  // rebuilds the dropdown; only prunes stale selections + updates label/lists.
  function renderRuns(runs) {
    allRuns = runs;
    if (!siteDropdownBuilt) buildSiteDropdown();
    const sites = sitesFromRuns();
    for (const s of [...siteFilter]) if (!sites.includes(s)) siteFilter.delete(s); // prune gone sites
    els.siteFilter.style.display = sites.length < 2 ? 'none' : '';
    updateTriggerLabel();
    const sig = sites.join('|');
    const panel = els.siteFilter.querySelector('#msPanel');
    if (panel && !panel.hidden && sig !== lastSitesSig) renderDropdownLists();
    lastSitesSig = sig;
    // Poll every non-terminal run regardless of the filter (background runs update).
    runs.forEach((r) => {
      if (r.status !== 'done' && r.status !== 'error' && !polling.has(r.id)) startPolling(r.id);
    });
    renderRunsList();
  }

  // Render just the run rows (respecting the active filter).
  function renderRunsList() {
    const shown = siteFilter.size
      ? allRuns.filter((r) => r.site && siteFilter.has(r.site))
      : allRuns;
    if (!shown.length) {
      els.runsList.innerHTML = allRuns.length
        ? '<p class="empty">No runs for the selected site(s).</p>'
        : '<p class="empty">No runs yet. Start one above.</p>';
      return;
    }
    const visible = shown.slice(0, runsLimit);
    const hidden = shown.length - visible.length;
    els.runsList.innerHTML =
      visible
        .map(
          (r) => `
      <div class="run" data-id="${r.id}">
        <div class="run-main">
          <div class="run-label">${escapeHtml(r.label)}</div>
          <div class="run-meta">${r.site ? `${escapeHtml(r.site)} · ` : ''}${r.pairCount} pair(s) · ${fmtTime(r.createdAt)}</div>
          <div class="run-config">${runConfigChips(r)}</div>
          ${
            r.status === 'done' && (r.analyzed != null || r.loadErrors)
              ? `<div class="run-stat">${r.analyzed ?? '?'} analyzed${
                  r.loadErrors ? ` · <span class="err-count">${r.loadErrors} load error${r.loadErrors === 1 ? '' : 's'}</span>` : ''
                }</div>`
              : ''
          }
        </div>
        <div class="run-side">
          <span class="status ${statusClass(r.status)}">${r.stage || r.status}</span>
          <div class="bar"><div class="bar-fill" style="width:${r.progress || 0}%"></div></div>
          <div class="run-actions">
            <button class="ghost load-btn" data-id="${r.id}" title="Load this run's settings into the form">Load</button>
            ${
              r.status === 'done'
                ? `<button class="ghost view-btn" data-id="${r.id}">View</button>`
                : ''
            }
            <button class="ghost del-btn" data-id="${r.id}" title="Delete this run (removes it from disk)">✕</button>
          </div>
        </div>
      </div>`
        )
        .join('') +
      (hidden > 0
        ? `<button class="ghost load-more" id="loadMoreRuns">Load ${Math.min(RUNS_PAGE, hidden)} more · ${hidden} older hidden</button>`
        : '');

    els.runsList.querySelectorAll('.view-btn').forEach((b) =>
      b.addEventListener('click', () => openResults(b.dataset.id))
    );
    els.runsList.querySelectorAll('.load-btn').forEach((b) =>
      b.addEventListener('click', () => loadRun(b.dataset.id))
    );
    els.runsList.querySelectorAll('.del-btn').forEach((b) =>
      b.addEventListener('click', () => deleteRun(b.dataset.id))
    );
    const more = els.runsList.querySelector('#loadMoreRuns');
    if (more)
      more.addEventListener('click', () => {
        runsLimit += RUNS_PAGE;
        renderRunsList();
      });
  }

  // Delete a run (from the list and from disk).
  async function deleteRun(jobId) {
    const run = allRuns.find((r) => r.id === jobId);
    const name = run ? run.label : jobId.slice(0, 8);
    if (!window.confirm(`Delete run "${name}"? This removes it from disk and can't be undone.`)) return;
    try {
      if (polling.has(jobId)) {
        clearInterval(polling.get(jobId));
        polling.delete(jobId);
      }
      await API.deleteRun(jobId);
      await refreshRuns();
    } catch (e) {
      els.startMsg.textContent = `Delete failed: ${e.message}`;
    }
  }

  // Load a run's settings back into the New-run form (overwrites current values).
  async function loadRun(jobId) {
    try {
      const job = await API.getRun(jobId);
      els.label.value = job.label || '';
      els.pairs.value = (job.pairs || []).map((p) => `${p.source},${p.target}`).join('\n');
      els.modeSelect.value = job.mode || 'text-only';
      els.threads.value = job.threads || 1;
      els.ignoreSource.value = (job.ignoreSource || []).join('\n');
      els.ignoreTarget.value = (job.ignoreTarget || []).join('\n');
      els.clickSource.value = (job.clickSource || []).join('\n');
      els.clickTarget.value = (job.clickTarget || []).join('\n');
      // Expand the ignore/click boxes that now hold selectors so they're visible.
      document.querySelectorAll('.ignore-box').forEach((box) => {
        box.open = [...box.querySelectorAll('textarea')].some((t) => t.value.trim());
      });
      els.startMsg.textContent = `Loaded settings from "${job.label || jobId.slice(0, 8)}"`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      els.startMsg.textContent = `Load failed: ${e.message}`;
    }
  }

  function startPolling(jobId) {
    const iv = setInterval(async () => {
      try {
        const job = await API.getRun(jobId);
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(iv);
          polling.delete(jobId);
        }
        await refreshRuns(); // cheap; re-renders bars/status
      } catch (e) {
        clearInterval(iv);
        polling.delete(jobId);
      }
    }, 1200);
    polling.set(jobId, iv);
  }

  async function refreshRuns() {
    const { runs } = await API.listRuns();
    renderRuns(runs);
  }

  async function startRun() {
    els.startMsg.textContent = '';
    const csv = els.pairs.value.trim();
    if (!csv) {
      els.startMsg.textContent = 'Add at least one source,target line.';
      return;
    }
    els.startBtn.disabled = true;
    try {
      const toLines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
      const { jobId } = await API.createRun({
        label: els.label.value.trim(),
        csv,
        mode: els.modeSelect.value,
        threads: Math.max(1, parseInt(els.threads.value, 10) || 1),
        recipe: els.recipeSelect.value || null,
        ignoreSource: toLines(els.ignoreSource.value),
        ignoreTarget: toLines(els.ignoreTarget.value),
        clickSource: toLines(els.clickSource.value),
        clickTarget: toLines(els.clickTarget.value),
      });
      els.startMsg.textContent = `Started (${jobId.slice(0, 8)}…)`;
      // Reveal-on-start: make sure the just-started run's site is visible even if a
      // different site filter was active. (Empty filter already shows everything.)
      const site = currentSite();
      if (site && siteFilter.size && !siteFilter.has(site)) siteFilter.add(site);
      // Keep the pairs, label, and ignore/click selectors in place so the run can
      // be tweaked and resubmitted without re-entering everything.
      await refreshRuns();
      startPolling(jobId);
    } catch (e) {
      els.startMsg.textContent = e.message;
    } finally {
      els.startBtn.disabled = false;
    }
  }

  const PAIRS_PAGE = 20;
  let resultsData = null;
  let resultsPairsLimit = PAIRS_PAGE;

  async function openResults(jobId) {
    els.results.hidden = false;
    document.querySelector('.layout').classList.add('show-results');
    els.resultsBody.innerHTML = '<p class="empty">Loading…</p>';
    try {
      resultsData = await API.getResults(jobId);
      resultsPairsLimit = PAIRS_PAGE;
      els.resultsTitle.textContent = `Results — ${resultsData.label || jobId.slice(0, 8)}`;
      renderResultsPairs();
    } catch (e) {
      els.resultsBody.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
    }
  }

  // Render the results drawer, capping the number of pairs shown (a run can have
  // thousands — the full set lives in the report behind "Open full report").
  function renderResultsPairs() {
    const data = resultsData;
    if (!data) return;
    const reportLinks = [];
    if (data.reportUrl)
      reportLinks.push(`<a class="report-link" href="${data.reportUrl}" target="_blank">Open full report ↗</a>`);
    if (data.customerReportUrl)
      reportLinks.push(`<a class="report-link" href="${data.customerReportUrl}" target="_blank">Customer report ↗</a>`);
    const header = reportLinks.length ? `<div class="report-links">${reportLinks.join('')}</div>` : '';
    const pairs = data.pairs || [];
    const visible = pairs.slice(0, resultsPairsLimit);
    const hidden = pairs.length - visible.length;
    const countLine =
      pairs.length > PAIRS_PAGE
        ? `<div class="results-count">Showing ${visible.length} of ${pairs.length} pairs</div>`
        : '';
    els.resultsBody.innerHTML =
      header +
      countLine +
      visible
        .map(
          (p) => `
        <div class="pair">
          <div class="pair-info">
            <div class="pair-urls">
              <div class="u"><span>src</span> ${escapeHtml(p.source)}</div>
              <div class="u"><span>tgt</span> ${escapeHtml(p.target)}</div>
            </div>
            <div class="pair-scores">
              <span class="verdict ${p.status}">${p.status}</span>
              <span class="note">${escapeHtml(p.note || '')}</span>
              ${p.reviewUrl ? `<a class="report-link" href="${p.reviewUrl}" target="_blank">review ↗</a>` : ''}
            </div>
            ${
              p.sourceShot || p.targetShot
                ? `<div class="shots">
                     ${p.sourceShot ? `<a class="shot" href="${p.sourceShotFull || p.sourceShot}" target="_blank"><span>source</span><img loading="lazy" src="${p.sourceShot}" alt="source" /></a>` : ''}
                     ${p.targetShot ? `<a class="shot" href="${p.targetShotFull || p.targetShot}" target="_blank"><span>target</span><img loading="lazy" src="${p.targetShot}" alt="target" /></a>` : ''}
                   </div>`
                : ''
            }
          </div>
        </div>`
        )
        .join('') +
      (hidden > 0
        ? `<button class="ghost load-more" id="loadMorePairs">Load ${Math.min(PAIRS_PAGE, hidden)} more · ${hidden} not shown (full set in the report)</button>`
        : '');
    const more = els.resultsBody.querySelector('#loadMorePairs');
    if (more)
      more.addEventListener('click', () => {
        resultsPairsLimit += PAIRS_PAGE;
        renderResultsPairs();
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // Browse: read chosen CSV file(s) client-side into the textarea.
  // Works in any browser and stays path-agnostic (no server upload needed).
  els.browseBtn.addEventListener('click', () => els.csvFile.click());
  els.csvFile.addEventListener('change', async () => {
    const files = [...els.csvFile.files];
    if (!files.length) return;
    try {
      const texts = await Promise.all(files.map((f) => f.text()));
      const merged = texts.join('\n').trim();
      // If the label is empty and a single file was picked, seed it from the filename.
      if (!els.label.value.trim() && files.length === 1) {
        els.label.value = files[0].name.replace(/\.csv$/i, '');
      }
      els.pairs.value = els.pairs.value.trim()
        ? `${els.pairs.value.trim()}\n${merged}`
        : merged;
      els.startMsg.textContent = `Loaded ${files.length} file(s).`;
    } catch (e) {
      els.startMsg.textContent = `Could not read file: ${e.message}`;
    } finally {
      els.csvFile.value = ''; // allow re-selecting the same file
    }
  });

  // --- Site recipes ---
  let recipeCache = [];
  async function refreshRecipes() {
    try {
      const { recipes } = await API.listRecipes();
      recipeCache = recipes || [];
    } catch {
      recipeCache = [];
    }
    const current = els.recipeSelect.value;
    els.recipeSelect.innerHTML =
      '<option value="">— none —</option>' +
      recipeCache
        .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`)
        .join('');
    if (recipeCache.some((r) => r.name === current)) els.recipeSelect.value = current;
    els.deleteRecipeBtn.hidden = !els.recipeSelect.value;
  }
  // Apply a recipe's saved settings to the ignore/click boxes (and mode/threads).
  function applyRecipe(r) {
    els.ignoreSource.value = (r.ignoreSource || []).join('\n');
    els.ignoreTarget.value = (r.ignoreTarget || []).join('\n');
    els.clickSource.value = (r.clickSource || []).join('\n');
    els.clickTarget.value = (r.clickTarget || []).join('\n');
    if (r.mode) els.modeSelect.value = r.mode;
    if (r.threads) els.threads.value = r.threads;
    document.querySelectorAll('.ignore-box').forEach((box) => {
      box.open = [...box.querySelectorAll('textarea')].some((t) => t.value.trim());
    });
    // Loading a recipe focuses the runs list on its site (if it has one).
    if (r.site) {
      siteFilter.clear();
      siteFilter.add(r.site);
      renderRuns(allRuns);
    }
  }
  els.recipeSelect.addEventListener('change', () => {
    els.deleteRecipeBtn.hidden = !els.recipeSelect.value;
    const r = recipeCache.find((x) => x.name === els.recipeSelect.value);
    if (r) {
      applyRecipe(r);
      els.startMsg.textContent = `Loaded recipe "${r.name}"`;
    }
  });
  els.saveRecipeBtn.addEventListener('click', async () => {
    const suggested = els.recipeSelect.value || els.label.value.trim() || '';
    const name = window.prompt('Save site recipe as:', suggested);
    if (!name || !name.trim()) return;
    try {
      const toLines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
      const { name: saved } = await API.saveRecipe({
        name: name.trim(),
        mode: els.modeSelect.value,
        threads: Math.max(1, parseInt(els.threads.value, 10) || 1),
        site: currentSite(),
        ignoreSource: toLines(els.ignoreSource.value),
        ignoreTarget: toLines(els.ignoreTarget.value),
        clickSource: toLines(els.clickSource.value),
        clickTarget: toLines(els.clickTarget.value),
      });
      await refreshRecipes();
      els.recipeSelect.value = saved;
      els.deleteRecipeBtn.hidden = false;
      els.startMsg.textContent = `Saved recipe "${saved}"`;
    } catch (e) {
      els.startMsg.textContent = `Save recipe failed: ${e.message}`;
    }
  });
  els.deleteRecipeBtn.addEventListener('click', async () => {
    const name = els.recipeSelect.value;
    if (!name || !window.confirm(`Delete recipe "${name}"?`)) return;
    try {
      await API.deleteRecipe(name);
      await refreshRecipes();
      els.recipeSelect.value = '';
      els.deleteRecipeBtn.hidden = true;
      els.startMsg.textContent = `Deleted recipe "${name}"`;
    } catch (e) {
      els.startMsg.textContent = `Delete failed: ${e.message}`;
    }
  });

  // Clicking the "New run" header clears the whole form back to defaults.
  function clearForm() {
    els.label.value = '';
    els.pairs.value = '';
    els.modeSelect.value = 'text-only';
    els.threads.value = 1;
    [els.ignoreSource, els.ignoreTarget, els.clickSource, els.clickTarget].forEach((t) => {
      t.value = '';
    });
    document.querySelectorAll('.ignore-box').forEach((box) => {
      box.open = false;
    });
    els.recipeSelect.value = '';
    els.deleteRecipeBtn.hidden = true;
    els.startMsg.textContent = '';
    els.label.focus();
  }
  const newRunTitle = $('#newRunTitle');
  newRunTitle.addEventListener('click', clearForm);
  newRunTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clearForm();
    }
  });

  // Wire up
  els.startBtn.addEventListener('click', startRun);
  els.refreshBtn.addEventListener('click', refreshRuns);
  els.closeResults.addEventListener('click', () => {
    els.results.hidden = true;
    document.querySelector('.layout').classList.remove('show-results');
  });

  (async () => {
    try {
      const h = await API.health();
      els.modeBadge.textContent = `mode: ${h.mode}`;
      els.modeBadge.classList.toggle('stub', h.mode === 'stub');
    } catch {
      els.modeBadge.textContent = 'offline';
    }
    await Promise.all([refreshRuns(), refreshRecipes()]);
  })();
})();
