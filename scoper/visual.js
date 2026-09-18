/*
 * scoper/visual.js — build the visual block inventory + correction UI from a cross-page inventory
 * (issue #65). One COLUMN per block TYPE (sorted by reach); within a column, a real screenshot CROP
 * of each detected instance (with faded ~30% context above/below so the wider picture is visible),
 * a per-instance CORRECTION dropdown (existing type / "➕ New block type" + name + characteristics)
 * and a "Because…" reason. Clicking a crop opens a MODAL with the full-page screenshot (the detected
 * band boxed in cyan) where the user can DRAW the true block region(s) and correct them — synced with
 * the main page. Corrections persist in localStorage + Export JSON (ground-truth / eval set + input
 * for the future adapt-vs-spawn loop). The "Analyze" button is DISABLED until the typing layer exists.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Correction vocabulary — the (rough) EDS block palette. The typing layer / block catalog refines this.
const VOCAB = ['Cards', 'Columns', 'Hero', 'Carousel', 'Accordion', 'Tabs', 'Gallery',
  'Quote', 'Stats / Counter', 'Media (image+text)', 'Table', 'Embed / Video',
  'Header', 'Footer', 'Breadcrumb', 'Default content (not a block)', 'Other'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// inv: buildInventory() output (each type carries `occurrences` with {url,dir,y0,y1,dpr}).
// opts: { label, perCol=16, pages=0, outBase=cwd }. Returns { outDir, cols, cropOk }.
async function buildVisual(inv, opts = {}) {
  const label = (opts.label || 'scope').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
  const perCol = opts.perCol || 16;
  const pages = opts.pages || 0;
  const outBase = opts.outBase || process.cwd();

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.join(outBase, `scoper-run_visual-${label}_${ts}`);
  fs.mkdirSync(path.join(outDir, 'crops'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'fulls'), { recursive: true });

  const idOf = (o) => `${path.basename(o.dir)}_${Math.round(o.y0)}`;
  const fullsDone = new Set();
  let cropOk = 0;

  // one downscaled full-page image per unique page (for the modal), referenced by page slug
  async function makeFull(o) {
    const slug = path.basename(o.dir);
    if (!fullsDone.has(slug)) {
      const shot = path.join(o.dir, 'screenshots', 'source-full.png');
      if (fs.existsSync(shot)) {
        try { await sharp(shot).resize({ width: 760 }).jpeg({ quality: 66 }).toFile(path.join(outDir, 'fulls', `${slug}.jpg`)); fullsDone.add(slug); } catch { /* skip */ }
      }
    }
    return `fulls/${slug}.jpg`;
  }

  const cols = [];
  for (const t of inv) {
    const items = [];
    for (const o of t.occurrences.slice(0, perCol)) {
      const id = idOf(o);
      const shot = path.join(o.dir, 'screenshots', 'source-full.png');
      let crop = null, full = null, bandTop = 0, bandBot = 1, topFade = 0, botFade = 0;
      if (fs.existsSync(shot)) {
        try {
          const meta = await sharp(shot).metadata();
          const dpr = o.dpr || 1, pngH = meta.height, pageHcss = pngH / dpr;
          const bandH = Math.max(1, o.y1 - o.y0);
          const cropTop = Math.max(0, o.y0 - 0.3 * bandH);
          const cropBot = Math.min(pageHcss, o.y1 + 0.3 * bandH);
          const topPx = Math.round(cropTop * dpr);
          const hPx = Math.min(pngH - topPx, Math.max(8, Math.round((cropBot - cropTop) * dpr)));
          if (hPx > 0) {
            await sharp(shot).extract({ left: 0, top: topPx, width: meta.width, height: hPx })
              .resize({ width: 480 }).jpeg({ quality: 68 }).toFile(path.join(outDir, 'crops', `${id}.jpg`));
            crop = `crops/${id}.jpg`; cropOk++;
          }
          const span = cropBot - cropTop || 1;
          topFade = (o.y0 - cropTop) / span; botFade = (cropBot - o.y1) / span;
          bandTop = (o.y0 * dpr) / pngH; bandBot = (o.y1 * dpr) / pngH;
          full = await makeFull(o);
        } catch { /* skip crop */ }
      }
      items.push({ id, url: o.url, crop, full, bandTop, bandBot, topFade, botFade });
    }
    cols.push({ type: t.subtype, pages: t.pages, instances: t.instances, signature: t.signature, items, total: t.occurrences.length });
  }

  const opt = ['<option value="">— correct —</option>', '<option value="__fragment__">⧉ Fragment of a larger block</option>', '<option value="__new__">➕ New block type…</option>']
    .concat(VOCAB.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)).join('');
  const fadePct = (f) => (Math.max(0, Math.min(1, f)) * 100).toFixed(1);
  const colHtml = cols.map((c) => `
    <section class="col">
      <header><div class="type">${esc(c.type)}</div><div class="meta">${c.pages} pages · ${c.instances} instances</div><div class="sig">${esc(c.signature)}</div></header>
      <div class="insts">
        ${c.items.map((it) => `<div class="inst" data-id="${esc(it.id)}" data-col="${esc(c.type)}" data-url="${esc(it.url)}" data-full="${esc(it.full || '')}" data-bandtop="${it.bandTop.toFixed(4)}" data-bandbot="${it.bandBot.toFixed(4)}">
          ${it.crop ? `<div class="crop" title="Click to see the full page & draw the true block">
              <img loading="lazy" src="${esc(it.crop)}">
              <div class="fade top" style="height:${fadePct(it.topFade)}%"></div>
              <div class="fade bot" style="height:${fadePct(it.botFade)}%"></div>
              <div class="bandmark t" style="top:${fadePct(it.topFade)}%"></div>
              <div class="bandmark b" style="bottom:${fadePct(it.botFade)}%"></div>
            </div>` : '<div class="nocrop">no screenshot</div>'}
          <div class="row"><a href="${esc(it.url)}" target="_blank" title="${esc(it.url)}">${esc(it.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 44) || '/')}</a><span class="badge"></span></div>
          <select class="fix">${opt}</select>
          <div class="detail" style="display:none">
            <textarea class="reason" rows="2" placeholder="Because… (why is this the correct type?)"></textarea>
            <div class="newfields" style="display:none">
              <input class="newname" placeholder="New block type name">
              <textarea class="newchar" rows="2" placeholder="Characteristics (what defines this block?)"></textarea>
            </div>
          </div>
        </div>`).join('')}
        ${c.total > c.items.length ? `<div class="more">+${c.total - c.items.length} more not shown</div>` : ''}
      </div>
    </section>`).join('');

  const css = `
    body{margin:0;font:13px system-ui,-apple-system,sans-serif;background:#eef0f3;color:#1c1c1c}
    .topbar{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #d8d8d8;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .topbar .sp{flex:1}
    .topbar b{font-size:14px}
    button{font:13px system-ui;padding:6px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}
    #export{background:#1a9e6a;color:#fff;border-color:#158a5c}
    #analyze[disabled]{opacity:.45;cursor:not-allowed}
    #status{color:#666;font-size:12px}
    .board{display:flex;align-items:flex-start;gap:14px;padding:14px;overflow-x:auto;min-height:80vh}
    .col{flex:0 0 500px;background:#fff;border:1px solid #e0e0e0;border-radius:8px}
    .col>header{background:#fafbfc;border-bottom:1px solid #eee;padding:10px 12px;border-radius:8px 8px 0 0}
    .type{font-weight:800;font-size:15px}
    .meta{color:#666;font-size:12px;margin-top:2px}
    .sig{font-family:ui-monospace,monospace;font-size:11px;color:#178a5c;margin-top:4px;word-break:break-all}
    .insts{padding:10px;display:flex;flex-direction:column;gap:14px}
    .inst{border:1px solid #ececec;border-radius:6px;padding:8px;background:#fff}
    .inst.flagged{border-color:#e06a00;box-shadow:0 0 0 2px rgba(224,106,0,.25)}
    .inst.newtype{border-color:#6a3fd0;box-shadow:0 0 0 2px rgba(106,63,208,.22)}
    .inst.fragment{border-color:#0f9aa8;box-shadow:0 0 0 2px rgba(15,154,168,.22)}
    .crop{position:relative;cursor:zoom-in;border:1px solid #eee;border-radius:4px;overflow:hidden;background:#fafafa}
    .crop img{width:100%;display:block}
    .fade{position:absolute;left:0;right:0;background:rgba(247,248,250,.66);pointer-events:none}
    .fade.top{top:0}.fade.bot{bottom:0}
    .bandmark{position:absolute;left:0;right:0;border-top:1px dashed rgba(23,138,92,.8);pointer-events:none}
    .nocrop{color:#aaa;padding:26px;text-align:center;border:1px dashed #ddd;border-radius:4px}
    .row{margin:6px 0 5px;display:flex;align-items:center;gap:6px}
    .inst a{color:#2a6bd0;text-decoration:none;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .badge{font-size:11px;color:#6a3fd0}
    select.fix{width:100%;padding:5px;border:1px solid #ccc;border-radius:5px;font:12px system-ui}
    .more{color:#999;text-align:center;padding:8px}
    .detail{margin-top:6px;display:flex;flex-direction:column;gap:6px}
    .detail textarea,.detail input,.rgn textarea,.rgn input,.rgn select{width:100%;box-sizing:border-box;padding:5px;border:1px solid #ccc;border-radius:5px;font:12px system-ui;resize:vertical}
    .newfields,.newfields2{display:flex;flex-direction:column;gap:6px;border-top:1px dashed #e0e0e0;padding-top:6px}
    .newname{font-weight:600}
    /* modal */
    .modal{position:fixed;inset:0;z-index:100;display:none}
    .mback{position:absolute;inset:0;background:rgba(20,22,28,.55)}
    .mbox{position:absolute;inset:24px;background:#fff;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .mhead{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #eee}
    .mhead .msp{flex:1}
    .mbody{flex:1;display:flex;min-height:0}
    .mstage{flex:1;overflow:auto;background:#4a4f57;position:relative;padding:14px}
    .mwrap{position:relative;cursor:crosshair;width:760px;max-width:100%;margin:0 auto}
    .mwrap img{display:block;width:100%}
    #mboxes{position:absolute;inset:0}
    .mband{position:absolute;border:2px solid #17c1d6;background:rgba(23,193,214,.14);pointer-events:none}
    .mband .lbl{position:absolute;top:-18px;left:0;background:#17c1d6;color:#083;font:700 10px ui-monospace;color:#003;padding:0 4px;border-radius:3px}
    .rbox{position:absolute;border:2px solid #e06a00;background:rgba(224,106,0,.12)}
    .rbox.sel{border-color:#6a3fd0;background:rgba(106,63,208,.16)}
    .rbox .rlbl{position:absolute;top:-17px;left:0;background:#e06a00;color:#fff;font:700 10px ui-monospace;padding:0 4px;border-radius:3px;white-space:nowrap}
    .mside{width:330px;border-left:1px solid #eee;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
    .mhint{color:#666;margin:0;font-size:12px;line-height:1.4}
    .rgn{border:1px solid #eee;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}
    .rgn.detected{border-color:#17c1d6;background:#f2fdff}
    .rgn .rh{display:flex;align-items:center;gap:6px;font-weight:700;font-size:12px}
    .rgn .rh .rsp{flex:1}
    .rgn .del{color:#c00;cursor:pointer;border:none;background:none;font-size:16px;padding:0}`;

  // Client JS — string concatenation only (no template literals / no "${" other than the two below,
  // which ARE interpolated at generation time: the localStorage key and the VOCAB list).
  const js = `
    var KEY = 'ppd-scoper-corrections-${label}';
    var VOCAB = ${JSON.stringify(VOCAB)};
    var store = JSON.parse(localStorage.getItem(KEY) || '{}');
    var save = function(){ localStorage.setItem(KEY, JSON.stringify(store)); setStatus(); };
    function setStatus(){ document.getElementById('status').textContent = Object.keys(store).length + ' corrections stored'; }
    function ent(id){ return store[id] || (store[id] = {}); }
    function clean(id){ var e = store[id]; if (e && !e.type && !(e.regions && e.regions.length)) delete store[id]; }
    function optionsHtml(sel){ var h = '<option value="">— set type —</option><option value="__fragment__"'+('__fragment__'===sel?' selected':'')+'>⧉ Fragment of a larger block</option><option value="__new__"'+('__new__'===sel?' selected':'')+'>➕ New block type…</option>'; for (var i=0;i<VOCAB.length;i++){ h += '<option value="'+VOCAB[i]+'"'+(VOCAB[i]===sel?' selected':'')+'>'+VOCAB[i]+'</option>'; } return h; }

    // ---- main-page instance sync ----
    function renderInst(inst){
      var id = inst.dataset.id, e = store[id] || {};
      var sel = inst.querySelector('select.fix');
      sel.value = e.type || '';
      var isNew = e.type === '__new__', isFrag = e.type === '__fragment__', has = !!e.type;
      var isType = has && !isNew && !isFrag;
      inst.querySelector('.detail').style.display = has ? 'flex' : 'none';
      inst.querySelector('.newfields').style.display = isNew ? 'flex' : 'none';
      inst.querySelector('.reason').value = e.reason || '';
      inst.querySelector('.newname').value = e.newName || '';
      inst.querySelector('.newchar').value = e.characteristics || '';
      inst.classList.toggle('flagged', isType && e.type !== inst.dataset.col);
      inst.classList.toggle('newtype', isNew);
      inst.classList.toggle('fragment', isFrag);
      var nr = (e.regions && e.regions.length) || 0, parts = [];
      if (isFrag) parts.push('⧉ fragment'); else if (isNew) parts.push('➕ ' + (e.newName || 'new type')); else if (isType) parts.push('→ ' + e.type);
      if (nr) parts.push('✎ ' + nr + ' region' + (nr > 1 ? 's' : ''));
      inst.querySelector('.badge').textContent = parts.join(' · ');
    }
    function saveBaseFromInst(inst){
      var id = inst.dataset.id, e = ent(id), v = inst.querySelector('select.fix').value;
      e.url = inst.dataset.url; e.was = inst.dataset.col;
      if (v) { e.type = v; e.reason = inst.querySelector('.reason').value.trim();
        if (v === '__new__'){ e.newName = inst.querySelector('.newname').value.trim(); e.characteristics = inst.querySelector('.newchar').value.trim(); } }
      else { delete e.type; delete e.reason; delete e.newName; delete e.characteristics; }
      clean(id); save(); renderInst(inst);
    }
    document.querySelectorAll('.inst').forEach(function(inst){
      renderInst(inst);
      inst.querySelector('select.fix').addEventListener('change', function(){ saveBaseFromInst(inst); });
      ['.reason','.newname','.newchar'].forEach(function(s){ inst.querySelector(s).addEventListener('input', function(){ saveBaseFromInst(inst); }); });
      var crop = inst.querySelector('.crop');
      if (crop) crop.addEventListener('click', function(){ openModal(inst); });
    });
    setStatus();
    document.getElementById('export').onclick = function(){
      var blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'scoper-corrections-${label}.json'; a.click();
    };
    document.getElementById('analyze').onclick = function(){
      if (!Object.keys(store).length){ alert('No corrections yet — set a type or draw a region first.'); return; }
      document.getElementById('export').click();
      alert('Corrections exported.\\n\\nTo learn from them (deterministic, no AI):\\n  node scoper/analyze.js <downloaded .json> <corpus>/pairs\\n\\nThen re-run:  node scoper/scope.js <corpus>\\nto re-type with the updated store.');
    };

    // ---- modal: full page + draw true-block regions ----
    var M = { inst:null, id:null, sel:-1 };
    var modal = document.getElementById('modal');
    var wrap = document.getElementById('mwrap');
    var img = document.getElementById('mimg');
    var boxes = document.getElementById('mboxes');
    var side = document.getElementById('mregions');
    document.getElementById('mclose').onclick = closeModal;
    document.querySelector('.mback').onclick = closeModal;
    function closeModal(){ modal.style.display='none'; if (M.inst) renderInst(M.inst); M.inst=null; }

    function openModal(inst){
      M.inst = inst; M.id = inst.dataset.id; M.sel = -1;
      document.getElementById('mtitle').textContent = inst.dataset.col + '  —  ' + inst.dataset.url.replace(/^https?:\\/\\/[^/]+/, '');
      img.onload = drawBoxes;
      img.src = inst.dataset.full || '';
      if (img.complete) drawBoxes();
      renderRegions();
      modal.style.display = 'block';
    }
    function drawBoxes(){
      boxes.innerHTML = '';
      var bt = parseFloat(M.inst.dataset.bandtop)||0, bb = parseFloat(M.inst.dataset.bandbot)||0;
      var band = document.createElement('div'); band.className='mband';
      band.style.left='0'; band.style.width='100%'; band.style.top=(bt*100)+'%'; band.style.height=((bb-bt)*100)+'%';
      band.innerHTML = '<span class="lbl">detected: '+M.inst.dataset.col+'</span>';
      boxes.appendChild(band);
      var e = store[M.id]; var rs = (e && e.regions) || [];
      rs.forEach(function(r, i){
        var d = document.createElement('div'); d.className='rbox'+(i===M.sel?' sel':'');
        d.style.left=(r.x*100)+'%'; d.style.top=(r.y*100)+'%'; d.style.width=(r.w*100)+'%'; d.style.height=(r.h*100)+'%';
        d.innerHTML='<span class="rlbl">'+(r.type||'(unset)')+'</span>';
        d.addEventListener('mousedown', function(ev){ ev.stopPropagation(); M.sel=i; drawBoxes(); renderRegions(); });
        boxes.appendChild(d);
      });
    }
    function renderRegions(){
      var e = store[M.id] || {}; var rs = e.regions || [];
      var html = '<div class="rgn detected"><div class="rh">Detected band <span class="rsp"></span></div>'
        + '<select class="dt">'+optionsHtml(e.type||'')+'</select>'
        + '<textarea class="dr" rows="2" placeholder="Because… (why is the detected band right/wrong?)">'+(e.reason||'')+'</textarea>'
        + (e.type==='__new__' ? '<div class="newfields2"><input class="dn" placeholder="New block type name" value="'+(e.newName||'')+'"><textarea class="dc" rows="2" placeholder="Characteristics">'+(e.characteristics||'')+'</textarea></div>' : '')
        + '</div>';
      rs.forEach(function(r,i){
        html += '<div class="rgn" data-i="'+i+'"><div class="rh">Region '+(i+1)+' <span class="rsp"></span><button class="del" title="delete">✕</button></div>'
          + '<select class="rt">'+optionsHtml(r.type||'')+'</select>'
          + '<textarea class="rr" rows="2" placeholder="Because… (why is this the true block?)">'+(r.reason||'')+'</textarea>'
          + (r.type==='__new__' ? '<div class="newfields2"><input class="rn" placeholder="New block type name" value="'+(r.newName||'')+'"><textarea class="rc" rows="2" placeholder="Characteristics">'+(r.characteristics||'')+'</textarea></div>' : '')
          + '</div>';
      });
      side.innerHTML = html;
      // detected-band form -> base fields (synced with main page)
      var dt = side.querySelector('.dt');
      dt.onchange = function(){ var e=ent(M.id); e.url=M.inst.dataset.url; e.was=M.inst.dataset.col; if(dt.value){e.type=dt.value;}else{delete e.type;delete e.reason;delete e.newName;delete e.characteristics;} clean(M.id); save(); renderRegions(); };
      var dr = side.querySelector('.dr'); if (dr) dr.oninput = function(){ ent(M.id).reason = dr.value.trim(); save(); };
      var dn = side.querySelector('.dn'); if (dn) dn.oninput = function(){ ent(M.id).newName = dn.value.trim(); save(); };
      var dc = side.querySelector('.dc'); if (dc) dc.oninput = function(){ ent(M.id).characteristics = dc.value.trim(); save(); };
      // region forms
      side.querySelectorAll('.rgn[data-i]').forEach(function(el){
        var i = +el.dataset.i, e = store[M.id], r = e.regions[i];
        el.querySelector('.rt').onchange = function(){ r.type = this.value; save(); renderRegions(); drawBoxes(); };
        el.querySelector('.rr').oninput = function(){ r.reason = this.value.trim(); save(); };
        var rn = el.querySelector('.rn'); if (rn) rn.oninput = function(){ r.newName = this.value.trim(); save(); };
        var rc = el.querySelector('.rc'); if (rc) rc.oninput = function(){ r.characteristics = this.value.trim(); save(); };
        el.querySelector('.del').onclick = function(){ e.regions.splice(i,1); if(!e.regions.length) delete e.regions; clean(M.id); M.sel=-1; save(); renderRegions(); drawBoxes(); };
      });
    }
    // draw a new rectangle by dragging on the page
    var drag = null;
    wrap.addEventListener('mousedown', function(ev){
      if (ev.target.closest && ev.target.closest('.rbox')) return; // clicking an existing region selects it
      var rect = wrap.getBoundingClientRect();
      drag = { x0:(ev.clientX-rect.left)/rect.width, y0:(ev.clientY-rect.top)/rect.height, rectEl:null };
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function(ev){
      if (!drag) return;
      var rect = wrap.getBoundingClientRect();
      var x1=(ev.clientX-rect.left)/rect.width, y1=(ev.clientY-rect.top)/rect.height;
      var x=Math.max(0,Math.min(drag.x0,x1)), y=Math.max(0,Math.min(drag.y0,y1));
      var w=Math.min(1,Math.max(drag.x0,x1))-x, h=Math.min(1,Math.max(drag.y0,y1))-y;
      if (!drag.rectEl){ drag.rectEl=document.createElement('div'); drag.rectEl.className='rbox sel'; boxes.appendChild(drag.rectEl); }
      drag.rectEl.style.left=(x*100)+'%'; drag.rectEl.style.top=(y*100)+'%'; drag.rectEl.style.width=(w*100)+'%'; drag.rectEl.style.height=(h*100)+'%';
      drag.cur={x:x,y:y,w:w,h:h};
    });
    window.addEventListener('mouseup', function(){
      if (!drag) return;
      var d = drag; drag = null;
      if (d.cur && d.cur.w>0.02 && d.cur.h>0.01){
        var e = ent(M.id); e.url=M.inst.dataset.url; e.was=M.inst.dataset.col; if(!e.regions) e.regions=[];
        e.regions.push({ x:+d.cur.x.toFixed(4), y:+d.cur.y.toFixed(4), w:+d.cur.w.toFixed(4), h:+d.cur.h.toFixed(4), type:'', reason:'' });
        // auto: a region overlapping the detected band means the tool over-segmented -> mark it a
        // fragment (only if no verdict was chosen yet; a region drawn elsewhere leaves it alone).
        var bt = parseFloat(M.inst.dataset.bandtop)||0, bb = parseFloat(M.inst.dataset.bandbot)||0;
        var ov = Math.min(bb, d.cur.y + d.cur.h) - Math.max(bt, d.cur.y);
        if (!e.type && ov / Math.max(0.0001, bb - bt) > 0.4) e.type = '__fragment__';
        M.sel = e.regions.length-1; save();
      }
      renderRegions(); drawBoxes();
    });`;

  const html = `<!doctype html><html><head><meta charset="utf8"><title>scoper visual inventory — ${esc(label)}</title><style>${css}</style></head><body>
    <div class="topbar">
      <b>Scoper — visual block inventory</b>
      <span>${esc(label)} · ${pages} pages · ${cols.length} block types</span>
      <span class="sp"></span>
      <button id="export">⬇ Export corrections JSON</button>
      <button id="analyze" title="Export corrections and show the analyze command">▶ Analyze corrections</button>
      <span id="status"></span>
    </div>
    <div class="board">${colHtml}</div>
    <div class="modal" id="modal">
      <div class="mback"></div>
      <div class="mbox">
        <div class="mhead"><b id="mtitle"></b><span class="msp"></span><button id="mclose">Close ✕</button></div>
        <div class="mbody">
          <div class="mstage"><div class="mwrap" id="mwrap"><img id="mimg"><div id="mboxes"></div></div></div>
          <div class="mside">
            <p class="mhint">Drag on the page to draw the <b>true</b> block region(s), then set each one's type + reason. The <b style="color:#0aa">cyan</b> box is what the tool detected. Edits here sync with the main page.</p>
            <div id="mregions"></div>
          </div>
        </div>
      </div>
    </div>
    <script>${js}</script></body></html>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  return { outDir, cols: cols.length, cropOk };
}

module.exports = { buildVisual, VOCAB };
