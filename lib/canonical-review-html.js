/**
 * canonical-review-html — interactive review page for the canonical-layout
 * comparison. The default backdrop is the *pear* (the reconstructed canvas), so
 * the boxes align with what's drawn by construction. When the original
 * screenshots are available it also offers a Pear ⇄ Screenshot toggle, so you
 * can drop the same overlay onto the real page and see where each index
 * actually lands (positioned elements included). Connectors link each matched
 * index from its source origin to its target counterpart's origin.
 */

const { renderPearNodes, fontHead } = require('./canonical-layout');

function slimItem(it) {
  const o = { i: it.idx, x: it.x, y: it.y, w: it.w, h: it.h, t: it.text, m: !!it.matched, mv: !!it.moved };
  if (it.counterpart) {
    o.cx = it.counterpart.x;
    o.cy = it.counterpart.y;
    o.cw = it.counterpart.w;
    o.ch = it.counterpart.h;
  }
  if (it.groupFirst) o.g = it.groupFirst; // reflow group's first-element origins
  if (it.kind === 'image') o.img = 1; // image leaf (vs text)
  return o;
}

function buildCanonicalReviewHtml(o) {
  // Slim triggers for the client payload: geometry + reveal list + the child
  // state signature (when this base trigger opens a captured state, so its purple
  // box descends into it). Per-state backdrops are the crawl screenshots, served
  // from disk and shown via one reusable <img> (see #stateShot) — no per-state
  // pear blocks embedded in the HTML.
  const slimTrigs = (list) => (list || []).map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, label: t.label, revealed: t.revealed || [], sig: t.sig || null }));
  const data = {
    sourceUrl: o.sourceUrl || '',
    targetUrl: o.targetUrl || '',
    sourceDims: o.sourceDims || { w: 1920, h: 1080 },
    targetDims: o.targetDims || { w: 1920, h: 1080 },
    sourceImg: o.sourceImg || null,
    targetImg: o.targetImg || null,
    source: (o.alignment?.source || []).map(slimItem),
    target: (o.alignment?.target || []).map(slimItem),
    // Clickable element regions per side (for the "Clickable" overlay layer).
    clickables: { source: o.sourceClm?.clickables || [], target: o.targetClm?.clickables || [] },
    // Interaction-gated content from the crawl (present-behind-click / missing-even-via-click).
    gated: o.gated || null,
    // Crawl triggers grouped with what each reveals (for click-to-reveal).
    triggers: o.triggers ? { source: slimTrigs(o.triggers.source), target: slimTrigs(o.triggers.target) } : null,
    // Interaction state graph (discovery tree) for the breadcrumb navigator:
    // each state keyed by signature, with its own screenshot + child triggers.
    graph: o.graph || null,
    // HIDDEN SLIDER CONTENT (#63): off-screen slider items + their text runs at
    // natural-flow positions, per side, plus the missing/extra classification
    // (normalized texts) so the "Hidden content" layer can label each run.
    hidden: {
      source: { items: o.sourceClm?.hiddenItems || [], nodes: o.sourceClm?.hiddenNodes || [] },
      target: { items: o.targetClm?.hiddenItems || [], nodes: o.targetClm?.hiddenNodes || [] },
    },
    hiddenDiff: {
      missing: (o.hiddenContent?.missing || []).map((m) => m.text).filter(Boolean),
      extra: (o.hiddenContent?.extra || []).map((e) => e.text).filter(Boolean),
    },
    audit: o.audit || null,
  };
  const hasShots = !!(data.sourceImg && data.targetImg);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const srcCanvas = renderPearNodes(o.sourceClm);
  const tgtCanvas = renderPearNodes(o.targetClm);
  // #63: hidden slider content rendered pear-style (formatted, positioned text at
  // the re-based flow coords) — same renderer as the main pear, so it overlaps its
  // own boxes like real content instead of an unformatted SVG run. Shown faded via
  // the .hiddenlayer opacity; toggled with 'Hidden content'.
  // Each hidden item's faded self-screenshot (captured in capture.js) painted
  // BEHIND its pear-style text, so a hidden slide shows its real image with the
  // formatted text overlapping (like the main pear over a screenshot backdrop).
  const hiddenGhostImgs = (items) =>
    (items || [])
      .filter((it) => it.ghost)
      .map((it) => `<img class="hg" src="${it.ghost}" alt="" draggable="false" style="position:absolute;left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px">`)
      .join('\n');
  const srcHiddenCanvas = hiddenGhostImgs(o.sourceClm?.hiddenItems) + '\n' + renderPearNodes({ nodes: o.sourceClm?.hiddenNodes || [] });
  const tgtHiddenCanvas = hiddenGhostImgs(o.targetClm?.hiddenItems) + '\n' + renderPearNodes({ nodes: o.targetClm?.hiddenNodes || [] });
  // Load both pages' web fonts so each pear renders in its real typeface.
  const fonts = {
    faces: [o.sourceClm?.fonts?.faces, o.targetClm?.fonts?.faces].filter(Boolean).join('\n'),
    links: [...new Set([...(o.sourceClm?.fonts?.links || []), ...(o.targetClm?.fonts?.links || [])])],
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Canonical layout review</title>
${fontHead(fonts)}
<style>
  :root{--src:#00a000;--tgt:#e00000;--align:#0060ff;--moved:#ff8800;--click:#9b30ff;--hidden:#00b3b3}
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.4 system-ui,sans-serif;background:#333;color:#eee}
  #bar{position:fixed;top:0;left:0;right:0;z-index:10;background:#111;border-bottom:1px solid #444;
    padding:6px 10px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  #bar b{color:#fff}
  .seg button{background:#333;color:#ddd;border:1px solid #555;padding:4px 10px;cursor:pointer}
  .seg button.on{background:#0060ff;color:#fff;border-color:#0060ff}
  label{user-select:none;cursor:pointer}
  .sw{display:inline-block;width:10px;height:10px;margin-right:3px;vertical-align:middle;border:1px solid #000}
  #wrap{display:flex;margin-top:44px}
  #stage{position:relative;flex:1;overflow:auto;height:calc(100vh - 44px);background:#fff;user-select:none;-webkit-user-select:none}
  #inner{position:relative}
  .pear{position:absolute;top:0;left:0;background:#fff}
  .hiddenlayer{background:transparent;z-index:2;opacity:0.7;pointer-events:none}
  .hiddenlayer .hg{opacity:0.55;filter:saturate(0.85)}
  .shot{position:absolute;top:0;left:0;z-index:1;display:none;-webkit-user-drag:none;user-select:none}
  #ov{position:absolute;top:0;left:0;z-index:2;pointer-events:none}
  #side{width:290px;background:#1a1a1a;border-left:1px solid #444;overflow:auto;height:calc(100vh - 44px);padding:6px}
  #side h4{margin:8px 4px 4px;color:#fff}
  .row{padding:3px 6px;border-bottom:1px solid #2a2a2a;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row:hover{background:#2a2a2a}
  .row.miss{color:#8f8}.row.extra{color:#f99}.row.moved{color:#fb0}
  .row.gated{color:#7a9a7a}.row.gatedmiss{color:#a97a7a}
  #side h4.gatedh{color:#9aa;border-top:1px solid #333;margin-top:12px;padding-top:8px}
  small{color:#999}
  @keyframes glowpulse{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}
  #ov .glow{filter:drop-shadow(0 0 5px #ffd000);animation:glowpulse 1.6s ease-out forwards;pointer-events:none}
  /* Hover glow on a clickable box so it's obvious exactly what you're about to click.
     CSS overrides the inline presentation attrs (fill-opacity/stroke-width). */
  #ov rect.clk{transition:fill-opacity .12s ease,stroke-width .12s ease}
  #ov rect.clk:hover{fill-opacity:0.34;stroke-width:4;filter:drop-shadow(0 0 6px var(--click))}
  #pop{position:absolute;display:none;z-index:5;max-width:360px;background:#111;border:1px solid var(--click);border-radius:5px;
    padding:7px 9px;font:12px/1.45 system-ui,sans-serif;color:#eee;box-shadow:0 6px 18px rgba(0,0,0,.55)}
  #pop b{color:#fff}#pop hr{border:0;border-top:1px solid #333;margin:5px 0}
  #pop .rp{color:#8f8}#pop .rm{color:#f99}#pop div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .crumb{background:var(--click);color:#fff;border:1px solid var(--click);padding:4px 9px;cursor:pointer;border-radius:3px}
  .crumb:hover{filter:brightness(1.15)}
  #stateBar{gap:6px;align-items:center}
</style></head><body>
<div id="bar">
  <b>Canonical review</b>
  <span class="seg"><button id="bSide" class="on">SOURCE / target</button></span>
  ${hasShots ? '<span class="seg"><button id="bPear" class="on">Pear</button><button id="bShot">Screenshot</button></span>' : ''}
  <label><span class="sw" style="background:var(--src)"></span><input type="checkbox" id="tSrc" checked>Source boxes</label>
  <label><span class="sw" style="background:var(--tgt)"></span><input type="checkbox" id="tTgt" checked>Target boxes</label>
  <label><span class="sw" style="background:var(--align)"></span><input type="checkbox" id="tAlign" checked>Aligned</label>
  <label><span class="sw" style="background:var(--moved)"></span><input type="checkbox" id="tMoved" checked>Moved</label>
  <label><input type="checkbox" id="tIdx">Indices</label>
  <label><input type="checkbox" id="tLine">Connectors</label>
  <label><span class="sw" style="background:var(--click)"></span><input type="checkbox" id="tClick">Clickable</label>
  <label title="Highlight newly-revealed text inside a state: green=this side only, red=other side only, blue=both"><span class="sw" style="background:linear-gradient(90deg,var(--src) 33%,var(--align) 33% 66%,var(--tgt) 66%)"></span><input type="checkbox" id="tReveal" checked>Revealed text</label>
  <label title="Off-screen slider/carousel items (hidden content) laid out at their natural flow position (slides flow right). Text is coloured when it's missing on target (source view) or extra on target (target view)."><span class="sw" style="background:var(--hidden)"></span><input type="checkbox" id="tHidden">Hidden content</label>
  <span id="connLegend" style="display:none"><small>drift
    <span class="sw" style="background:#22c55e"></span>&le;20
    <span class="sw" style="background:#eab308"></span>&le;40
    <span class="sw" style="background:#ef4444"></span>&gt;40</small></span>
  <button id="bReset" style="display:none;background:#333;color:#ddd;border:1px solid #555;padding:4px 10px;cursor:pointer">Reset align</button>
  <span class="seg"><button id="bPanel">Diffs</button></span>
  <span id="stateBar" style="display:none"></span>
  <span id="stat"><small></small></span>
</div>
<div id="wrap">
  <div id="stage"><div id="inner">
    <div class="pear" id="pearSrc">${srcCanvas}</div>
    <div class="pear" id="pearTgt" style="display:none">${tgtCanvas}</div>
    <div class="pear hiddenlayer" id="hiddenSrc" style="display:none">${srcHiddenCanvas}</div>
    <div class="pear hiddenlayer" id="hiddenTgt" style="display:none">${tgtHiddenCanvas}</div>
    ${hasShots ? `<img id="shotSrc" class="shot" alt="" draggable="false" src="${data.sourceImg}" style="width:${data.sourceDims.w}px">
    <img id="shotTgt" class="shot" alt="" draggable="false" src="${data.targetImg}" style="width:${data.targetDims.w}px">` : ''}
    <img id="stateShot" class="shot" alt="" draggable="false" style="display:none">
    <svg id="ov" xmlns="http://www.w3.org/2000/svg"></svg>
    <div id="pop"></div>
  </div></div>
  <div id="side"></div>
</div>
<script>
const D=${json};
const SVGNS='http://www.w3.org/2000/svg';
let bgSide='source', backdrop='pear';
// Pin/sync: rigidly translate one side's boxes so a chosen pair's counterpart
// lands on top of the clicked box (cancels cumulative drift up to that anchor).
let syncShift=null;   // { side:'source'|'target', dx, dy } — the shifted side
let syncAnchor=null;  // { side, i } — the clicked box (drawn thicker)
let highlight=null, hlTimer=null; // { side, x, y, w, h } — a box to glow
let panelOpen=false;
let navStack=[]; // sigs from base (exclusive) to the current state; empty = base view
let baseScroll={top:0,left:0}; // stage scroll on the BASE view when we descended — restored on return
let hiddenLeftPad=0; // #63: left canvas margin so earlier hero slides (negative x) show left of the visible one
const el=id=>document.getElementById(id);
// hiddenLeftPad shifts EVERYTHING right (backdrop, boxes, ghosts) by the same
// amount, so negative-x hidden ghosts land at >=0 while staying registered.
const off=side=>{ const b=(syncShift&&syncShift.side===side)?syncShift:{dx:0,dy:0}; return {dx:b.dx+hiddenLeftPad, dy:b.dy}; };
// Translate each side's backdrop by its sync offset, so the shifted side's
// pear/screenshot moves with its boxes and stays registered at the anchor when
// you toggle sides.
function tr(o){ return 'translate('+o.dx+'px,'+o.dy+'px)'; }
function positionBackdrops(){ el('pearSrc').style.transform=tr(off('source')); el('pearTgt').style.transform=tr(off('target'));
  if(el('hiddenSrc')){ el('hiddenSrc').style.transform=tr(off('source')); el('hiddenTgt').style.transform=tr(off('target')); }
  if(el('shotSrc')){ el('shotSrc').style.transform=tr(off('source')); el('shotTgt').style.transform=tr(off('target')); } }
// Combine chosen side (source/target) with chosen backdrop (pear/screenshot).
function applyView(){
  hidePop();
  el('bSide').textContent=bgSide==='source'?'SOURCE / target':'source / TARGET';
  { const c=bgSide==='source'?'var(--src)':'var(--tgt)'; const bs=el('bSide'); bs.style.background=c; bs.style.borderColor=c; bs.style.color='#fff'; }
  if(el('bPear')){ el('bPear').classList.toggle('on',backdrop==='pear'); el('bShot').classList.toggle('on',backdrop==='shot'); }
  const pear=backdrop==='pear';
  el('pearSrc').style.display=(pear&&bgSide==='source')?'block':'none';
  el('pearTgt').style.display=(pear&&bgSide==='target')?'block':'none';
  // #63 hidden-content pear layer (base view only), shown faded when toggled on.
  { const sh=el('tHidden')&&el('tHidden').checked&&!navStack.length;
    if(el('hiddenSrc')){ el('hiddenSrc').style.display=(sh&&bgSide==='source')?'block':'none'; el('hiddenTgt').style.display=(sh&&bgSide==='target')?'block':'none'; } }
  // Two persistent screenshot imgs (src set once) — just toggle visibility, so
  // switching sides never re-fetches/re-decodes the big PNG (no jump/freeze).
  if(el('shotSrc')){ el('shotSrc').style.display=(!pear&&bgSide==='source')?'block':'none'; el('shotTgt').style.display=(!pear&&bgSide==='target')?'block':'none'; }
  const d=bgSide==='source'?D.sourceDims:D.targetDims;
  // Widen the canvas past the backdrop if any clickable box (e.g. a trigger hidden
  // off the right of a scroll strip, drawn at its TRUE x with a ghost) extends beyond
  // it, so the stage can scroll to reach every box. #62.
  const g=D.graph&&D.graph[bgSide]; let cw=d.w; let ch=d.h;
  if(g&&g.baseChildren) for(const c of g.baseChildren) cw=Math.max(cw, c.x+c.w+4);
  // Hidden slider items flow off BOTH edges (earlier slides left → negative x,
  // later slides right) — widen the canvas both ways so the stage can scroll to
  // reach them when 'Hidden content' is on (#63). leftPad shifts everything right.
  hiddenLeftPad=0;
  if(el('tHidden')&&el('tHidden').checked&&D.hidden&&D.hidden[bgSide]){
    let minX=0; for(const it of (D.hidden[bgSide].items||[])){ cw=Math.max(cw, it.x+it.w+8); ch=Math.max(ch, it.y+it.h+8); minX=Math.min(minX, it.x); }
    hiddenLeftPad=minX<0?(-minX+8):0;
  }
  const tw=cw+hiddenLeftPad;
  el('inner').style.width=tw+'px'; el('inner').style.height=ch+'px';
  const ov=el('ov'); ov.setAttribute('width',tw); ov.setAttribute('height',ch); ov.setAttribute('viewBox','0 0 '+tw+' '+ch);
  positionBackdrops(); render();
}
function box(it,color,side){ const g=document.createElementNS(SVGNS,'g');
  const o=off(side); const bx=it.x+o.dx, by=it.y+o.dy;
  const anchor=syncAnchor&&syncAnchor.side===side&&syncAnchor.i===it.i;
  const r=document.createElementNS(SVGNS,'rect'); r.setAttribute('x',bx);r.setAttribute('y',by);r.setAttribute('width',it.w);r.setAttribute('height',it.h);
  r.setAttribute('fill','none');r.setAttribute('stroke',color);r.setAttribute('stroke-width',anchor?'3.5':'2'); if(!it.m) r.setAttribute('stroke-dasharray','5 3');
  // Only the viewed side, and only SYNCABLE boxes (those with a counterpart),
  // capture clicks. Unpaired missing/extra boxes stay click-through so they
  // never sit on top of and block an overlapping matched box beneath them.
  if(side===bgSide && (it.cx!=null || it.g)){ r.setAttribute('pointer-events','all'); r.style.cursor='pointer'; r.onclick=()=>syncTo(it,side); }
  g.appendChild(r);
  if(el('tIdx').checked){ const t=document.createElementNS(SVGNS,'text'); const left=side==='source';
    t.setAttribute('x',left?Math.max(2,bx-3):bx+it.w+3); t.setAttribute('y',by+Math.min(it.h,13));
    t.setAttribute('font-size','12');t.setAttribute('font-family','monospace');t.setAttribute('font-weight','bold');t.setAttribute('fill',color);t.setAttribute('text-anchor',left?'end':'start'); t.textContent=it.i; g.appendChild(t); }
  return g; }
function clearSync(){ syncShift=null; syncAnchor=null; el('bReset').style.display='none'; positionBackdrops(); render(); }
// Pin the clicked box: translate the OTHER side so this pair's counterpart sits
// on top of it, then re-render (connectors follow). Clicking the current anchor
// again (or an unpaired missing/extra box) clears the sync — a toggle.
function syncTo(it,side){
  if(syncAnchor&&syncAnchor.side===side&&syncAnchor.i===it.i){ clearSync(); return; }
  let dx,dy;
  if(it.g){ // reflow group member: align the two groups' FIRST elements
    dx=side==='source'?it.g.sx-it.g.tx:it.g.tx-it.g.sx;
    dy=side==='source'?it.g.sy-it.g.ty:it.g.ty-it.g.sy;
  } else if(it.cx!=null){ dx=it.x-it.cx; dy=it.y-it.cy; }
  else { clearSync(); return; }
  const other=side==='source'?'target':'source';
  syncShift={side:other,dx,dy}; syncAnchor={side,i:it.i};
  el('bReset').style.display='inline-block'; positionBackdrops(); render();
}
// The connector line runs source-origin → target-origin (its length shows the
// absolute shift), but its COLOUR grades LOCAL drift: how much this item's
// shift (cx-x, cy-y) deviates from the MEDIAN shift of its spatial neighbours
// (nearest matched items by source-Y). A uniformly shifted page (harmless
// cumulative drift) scores ~0 and stays green; same-line siblings share a
// baseline so they get the same colour; only an element out of step with its
// neighbourhood spikes. max over x and y, thresholds 20/40:
//   <=20 green (OK) · <=40 yellow (ok-ish) · >40 red (needs work).
// Moved (reordered) items stay orange — a different signal than local drift.
const CONN_GOOD=20, CONN_OKISH=40, DRIFT_K=10;
function median(a){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function computeDrifts(){
  const M=D.source.filter(it=>!it.mv&&it.m&&it.cx!=null);
  for(const it of M){
    const near=M.filter(o=>o!==it).sort((a,b)=>Math.abs(a.y-it.y)-Math.abs(b.y-it.y)).slice(0,DRIFT_K);
    if(!near.length){ it._drift=0; continue; }
    const mdx=median(near.map(o=>o.cx-o.x)), mdy=median(near.map(o=>o.cy-o.y));
    it._drift=Math.max(Math.abs((it.cx-it.x)-mdx),Math.abs((it.cy-it.y)-mdy));
  } }
function connColor(it){ if(it.mv) return 'var(--moved)';
  const d=it._drift||0;
  return d<=CONN_GOOD?'#22c55e':d<=CONN_OKISH?'#eab308':'#ef4444'; }
// Ghost for a HIDDEN clickable (a trigger clipped out of a scroll strip, so it isn't
// in the static backdrop): a 0.5-alpha screenshot of the element drawn AT its true
// location — "this is here, but it's hidden" — with the clickable outline on top.
function ghostImg(c,x,y){ if(!c||!c.ghost) return null; const im=document.createElementNS(SVGNS,'image');
  im.setAttributeNS('http://www.w3.org/1999/xlink','href',c.ghost); im.setAttribute('href',c.ghost);
  im.setAttribute('x',x);im.setAttribute('y',y);im.setAttribute('width',c.w);im.setAttribute('height',c.h);
  im.setAttribute('opacity','0.5');im.setAttribute('preserveAspectRatio','none');im.setAttribute('pointer-events','none'); return im; }
function connector(it){ const so=off('source'), to=off('target'); const p=document.createElementNS(SVGNS,'line');
  p.setAttribute('x1',it.x+so.dx);p.setAttribute('y1',it.y+so.dy);p.setAttribute('x2',it.cx+to.dx);p.setAttribute('y2',it.cy+to.dy);
  p.setAttribute('stroke',connColor(it));p.setAttribute('stroke-width','1.5');
  p.setAttribute('opacity','0.65'); return p; }
function render(){ if(navStack.length){ renderStateOverlay(); return; } const ov=el('ov'); ov.innerHTML=''; const showAlign=el('tAlign').checked; const showMoved=el('tMoved').checked;
  const lines=el('tLine').checked; el('connLegend').style.display=lines?'inline':'none';
  const trigs=D.triggers&&D.triggers[bgSide]; // crawl triggers that revealed content (interactive)
  // All clickable regions as passive dashed markers (drawn under the boxes); the
  // content-revealing triggers are additionally drawn interactive on top below.
  if(el('tClick').checked){ const o=off(bgSide); for(const c of (D.clickables[bgSide]||[])){ const r=document.createElementNS(SVGNS,'rect');
    r.setAttribute('x',c.x+o.dx);r.setAttribute('y',c.y+o.dy);r.setAttribute('width',c.w);r.setAttribute('height',c.h);
    r.setAttribute('fill','none');r.setAttribute('stroke','var(--click)');r.setAttribute('stroke-width','1.5');r.setAttribute('stroke-dasharray','2 2');r.setAttribute('opacity','0.6'); ov.appendChild(r); } }
  // Connectors (under the boxes): one per index that has a counterpart.
  if(lines) for(const it of D.source){ if(it.cx==null) continue; if(it.mv&&!showMoved) continue; ov.appendChild(connector(it)); }
  // Colour follows match status, not pixel overlap: source/target legitimately
  // render at different coordinates across platforms, so a matched pair is
  // "aligned" (blue) even when the boxes don't overlap. Green = missing on
  // target, red = extra on target, orange = moved.
  if(el('tSrc').checked) for(const it of D.source){
    if(it.mv){ if(showMoved) ov.appendChild(box(it,'var(--moved)','source')); continue; }
    ov.appendChild(box(it,(showAlign&&it.m)?'var(--align)':'var(--src)','source')); }
  if(el('tTgt').checked) for(const it of D.target){
    if(it.mv){ if(showMoved) ov.appendChild(box(it,'var(--moved)','target')); continue; }
    ov.appendChild(box(it,(showAlign&&it.m)?'var(--align)':'var(--tgt)','target')); }
  // Interactive layer (on top): ONE box per state reachable from base, straight
  // from the state GRAPH's base children (each with its own trigger geometry).
  // Clicking descends into the state. No legacy text-reveal overlay boxes — the
  // graph is the single source of clickable state entries (no more double boxes).
  if(el('tClick').checked){ const o=off(bgSide); const g=D.graph&&D.graph[bgSide];
    // Largest first → smaller boxes paint on top (see renderStateOverlay). #62 UX.
    for(const c of [...((g&&g.baseChildren)||[])].sort((a,b)=>(b.w*b.h)-(a.w*a.h))){
      const gi=ghostImg(c,c.x+o.dx,c.y+o.dy); if(gi) ov.appendChild(gi);
      const r=document.createElementNS(SVGNS,'rect');
      r.setAttribute('x',c.x+o.dx);r.setAttribute('y',c.y+o.dy);r.setAttribute('width',c.w);r.setAttribute('height',c.h);
      r.setAttribute('fill','var(--click)');r.setAttribute('fill-opacity','0.16');r.setAttribute('stroke','var(--click)');r.setAttribute('stroke-width','2.5');
      r.setAttribute('class','clk');
      r.setAttribute('pointer-events','all'); r.style.cursor='pointer'; r.onclick=(e)=>{ e.stopPropagation(); enterStateSig(bgSide,c.sig,c.label); }; ov.appendChild(r); } }
  // HIDDEN CONTENT layer (#63): off-screen slider/carousel items laid out at their
  // natural-flow positions (slides flow right of the visible one). Each item gets a
  // faded background box; each text run is drawn faded, and coloured + boxed when
  // it's MISSING on the other side (source view) / EXTRA (target view) — same
  // missing=green / extra=red logic as the rest of the review. Present-on-both text
  // stays neutral (nothing to flag).
  if(el('tHidden').checked && D.hidden && D.hidden[bgSide]){ const o=off(bgSide); const H=D.hidden[bgSide];
    const flagSet=new Set(bgSide==='source'?(D.hiddenDiff.missing||[]):(D.hiddenDiff.extra||[]));
    const flagCol=bgSide==='source'?'var(--src)':'var(--tgt)';
    // Item extents (faded teal) — the text/background comes from the #hiddenSrc/Tgt
    // pear layer beneath; here we only draw the item frame + missing/extra flags.
    for(const it of (H.items||[])){ const r=document.createElementNS(SVGNS,'rect');
      r.setAttribute('x',it.x+o.dx);r.setAttribute('y',it.y+o.dy);r.setAttribute('width',it.w);r.setAttribute('height',it.h);
      r.setAttribute('fill','var(--hidden)');r.setAttribute('fill-opacity','0.04');r.setAttribute('stroke','var(--hidden)');r.setAttribute('stroke-width','1');r.setAttribute('stroke-dasharray','4 3');r.setAttribute('opacity','0.8'); ov.appendChild(r); }
    // A text run MISSING on target (source view) / EXTRA on target (target view)
    // gets a coloured box over it — same green/red logic as the rest of the review.
    for(const n of (H.nodes||[])){ if(!flagSet.has(n.text)) continue; const r=document.createElementNS(SVGNS,'rect');
      r.setAttribute('x',n.x+o.dx-1);r.setAttribute('y',n.y+o.dy-1);r.setAttribute('width',Math.max(n.w,8)+2);r.setAttribute('height',n.h+2);
      r.setAttribute('fill',flagCol);r.setAttribute('fill-opacity','0.14');r.setAttribute('stroke',flagCol);r.setAttribute('stroke-width','1.5'); ov.appendChild(r); }
  }
  // Temporary glow on a diff-row's box (drawn last, always, regardless of layer
  // toggles). Coordinates are explicit + offset by the box's own side.
  if(highlight){ const o=off(highlight.side); const gr=document.createElementNS(SVGNS,'rect');
    gr.setAttribute('x',highlight.x+o.dx-4);gr.setAttribute('y',highlight.y+o.dy-4);gr.setAttribute('width',(highlight.w||1)+8);gr.setAttribute('height',(highlight.h||1)+8);
    gr.setAttribute('fill','none');gr.setAttribute('stroke','#ffd000');gr.setAttribute('stroke-width','3');gr.setAttribute('class','glow'); ov.appendChild(gr); }
}
// Glow a box (explicit side+geometry), scroll it into view, auto-expire.
function glowBox(hb){
  highlight=hb; render();
  el('stage').scrollTo({top:Math.max(0,(hb.y+off(hb.side).dy)-140),behavior:'smooth'});
  clearTimeout(hlTimer); hlTimer=setTimeout(()=>{ highlight=null; render(); },1600);
}
function hidePop(){ el('pop').style.display='none'; }
// Click-to-reveal: glow the trigger (no scroll) and pop up what it exposes, each
// line coloured by whether it's present (green) or missing (red) on the other side.
function showReveal(t){
  highlight={side:bgSide,x:t.x,y:t.y,w:t.w,h:t.h}; render();
  clearTimeout(hlTimer); hlTimer=setTimeout(()=>{ highlight=null; render(); },1600);
  const o=off(bgSide);
  const present=t.revealed.filter(r=>r.onOther==='present').length, missing=t.revealed.length-present;
  const pop=el('pop');
  pop.innerHTML='<b>Reveals '+t.revealed.length+'</b> via “'+escapeHtml((t.label||'(trigger)').slice(0,42))+'” '
    +'<small>'+present+' present / '+missing+' missing on other side</small><hr>'
    +t.revealed.slice(0,50).map(r=>'<div class="'+(r.onOther==='missing'?'rm':'rp')+'">'+escapeHtml(r.text.slice(0,80))+'</div>').join('');
  pop.style.left=(t.x+o.dx)+'px'; pop.style.top=(t.y+t.h+o.dy+4)+'px'; pop.style.display='block';
}
// ── Interaction state navigator (hierarchical, breadcrumb) ──────────────────
// navStack holds the sigs from base to the current state. Each state renders on
// its OWN captured full-page screenshot backdrop, with its own child triggers as
// purple clickable boxes (their geometry is in that state's own document space,
// so no snapping). Clicking a child box descends; the breadcrumb pops back up.
function stateNode(side,sig){ return D.graph && D.graph[side] && D.graph[side].states && D.graph[side].states[sig]; }
function curSig(){ const e=navStack[navStack.length-1]; return e&&e.sig; }
function enterStateSig(side,sig,label){
  if(!stateNode(side,sig)) return;
  // Descending from the BASE view: remember where the user was so returning to
  // Base restores it (instead of jumping to the top).
  if(!navStack.length){ const stg=el('stage'); if(stg) baseScroll={top:stg.scrollTop,left:stg.scrollLeft}; }
  if(bgSide!==side){ bgSide=side; applyView(); }
  // Store the CLICKED box's label with the entry, so the breadcrumb names how the user
  // actually got here — not the target state's discovery label (a 'known' edge can reach
  // a state first found via a different trigger, e.g. clicking a question but the state
  // was discovered via "Load more").
  navStack.push({sig,label:label||(stateNode(side,sig)||{}).label||'state'}); hidePop(); showState(); }
function showState(){
  const side=bgSide, n=stateNode(side,curSig()); if(!n){ exitToBase(); return; }
  // Hide every base backdrop; the state's own screenshot becomes the canvas.
  el('pearSrc').style.display='none'; el('pearTgt').style.display='none';
  if(el('hiddenSrc')){ el('hiddenSrc').style.display='none'; el('hiddenTgt').style.display='none'; }
  if(el('shotSrc')){ el('shotSrc').style.display='none'; el('shotTgt').style.display='none'; }
  const bw=n.w||(bgSide==='source'?D.sourceDims.w:D.targetDims.w); // backdrop width
  const h=n.h||(bgSide==='source'?D.sourceDims.h:D.targetDims.h);
  const img=el('stateShot');
  if(n.shot){ img.src=n.shot; img.style.width=bw+'px'; img.style.transform='none'; img.style.display='block'; }
  else img.style.display='none';
  // Widen the CANVAS (not the backdrop) past the shot if a child box — e.g. a trigger
  // hidden off the right of a scroll strip INSIDE this state — extends beyond it, so
  // the stage can scroll to reach it. Same fix as applyView, for state views. #62.
  let cw=bw; for(const c of (n.children||[])) cw=Math.max(cw, c.x+c.w+4);
  el('inner').style.width=cw+'px'; el('inner').style.height=h+'px';
  const ov=el('ov'); ov.setAttribute('width',cw); ov.setAttribute('height',h); ov.setAttribute('viewBox','0 0 '+cw+' '+h);
  buildCrumbs(); el('stateBar').style.display='inline-flex';
  // #62 — the state backdrop is a REVEAL-SCOPED shot: a viewport frame for overlays
  // (modals), or a taller doc-space clip framing an in-flow reveal (accordion /
  // "Load more") that runs past one screen. Either way the reveal sits from the top,
  // so reset the stage to the top of the frame (the stage scrolls if it's tall);
  // a preserved deep base-scroll would land past the backdrop and show blank canvas.
  const stg=el('stage'); if(stg){ stg.scrollTop=0; stg.scrollLeft=0; }
  renderStateOverlay();
}
// Purple clickable boxes = this state's child triggers (descend on click). No
// sync offset — the backdrop is the state's own screenshot, boxes share its space.
function renderStateOverlay(){ const ov=el('ov'); ov.innerHTML=''; const n=stateNode(bgSide,curSig()); if(!n) return;
  // #62 Phase C — the state backdrop is a VIEWPORT shot of the doc region
  // [scrollY, scrollY+h]. Child triggers are stored in DOCUMENT space, so offset
  // them by -scrollY to land on the viewport frame (x unchanged — no h-scroll).
  const sy=n.scrollY||0;
  // Newly-revealed text, drawn FIRST (under the clickable boxes, pointer-events off): the
  // same green/red/blue scheme as the box layers — green = this side only (missing on the
  // other), red = other side only, blue = present on both. Mirrors the Diffs panel's
  // "missing/extra on target".
  if(el('tReveal').checked) for(const rt of (n.revealText||[])){
    const col = rt.onOther==='present' ? 'var(--align)' : (bgSide==='source'?'var(--src)':'var(--tgt)');
    const h=document.createElementNS(SVGNS,'rect');
    h.setAttribute('x',rt.x);h.setAttribute('y',rt.y-sy);h.setAttribute('width',rt.w);h.setAttribute('height',rt.h);
    h.setAttribute('fill',col);h.setAttribute('fill-opacity','0.30');h.setAttribute('stroke',col);h.setAttribute('stroke-opacity','0.65');h.setAttribute('stroke-width','1');
    h.setAttribute('rx','2');h.setAttribute('pointer-events','none'); ov.appendChild(h); }
  // Paint LARGEST first so smaller boxes land on top (SVG has no z-index: paint order
  // = document order, and hit-testing hits the topmost-painted box). A small trigger
  // fully inside a big wrapper would otherwise be unreachable under it. #62 UX.
  for(const c of [...(n.children||[])].sort((a,b)=>(b.w*b.h)-(a.w*a.h))){
    const gi=ghostImg(c,c.x,c.y-sy); if(gi) ov.appendChild(gi);
    const r=document.createElementNS(SVGNS,'rect');
    r.setAttribute('x',c.x);r.setAttribute('y',c.y-sy);r.setAttribute('width',c.w);r.setAttribute('height',c.h);
    r.setAttribute('fill','var(--click)');r.setAttribute('fill-opacity','0.16');r.setAttribute('stroke','var(--click)');r.setAttribute('stroke-width','2.5');
    r.setAttribute('class','clk');
    r.setAttribute('pointer-events','all'); r.style.cursor='pointer'; r.onclick=(e)=>{ e.stopPropagation(); enterStateSig(bgSide,c.sig,c.label); };
    ov.appendChild(r); }
  if(highlight){ const gr=document.createElementNS(SVGNS,'rect');
    gr.setAttribute('x',highlight.x-4);gr.setAttribute('y',highlight.y-sy-4);gr.setAttribute('width',(highlight.w||1)+8);gr.setAttribute('height',(highlight.h||1)+8);
    gr.setAttribute('fill','none');gr.setAttribute('stroke','#ffd000');gr.setAttribute('stroke-width','3');gr.setAttribute('class','glow'); ov.appendChild(gr); } }
// Breadcrumb: "← Base" + one crumb per ancestor + the current state (plain text).
function buildCrumbs(){ const bar=el('stateBar'); const side=bgSide;
  let html='<button class="crumb" data-k="0">← Base</button>';
  for(let k=0;k<navStack.length;k++){ const ns=navStack[k]; const n=stateNode(side,ns.sig); const lab=escapeHtml(String((ns&&ns.label)||(n&&n.label)||'state').slice(0,26));
    if(k<navStack.length-1) html+=' <button class="crumb" data-k="'+(k+1)+'">← via “'+lab+'”</button>';
    else html+=' <small style="color:#cdb4ff">via “'+lab+'” · '+((n&&n.children&&n.children.length)||0)+' clickable</small>';
  }
  bar.innerHTML=html;
  bar.querySelectorAll('.crumb').forEach(b=>b.onclick=()=>popTo(+b.dataset.k)); }
function popTo(k){ navStack=navStack.slice(0,k); if(!navStack.length) exitToBase(); else showState(); }
function exitToBase(scroll){ navStack=[]; el('stateBar').style.display='none'; hidePop();
  if(el('stateShot')) el('stateShot').style.display='none'; applyView();
  // Leave the user where they were before descending (not scrolled to the top).
  const s=scroll||baseScroll; const stg=el('stage'); if(stg){ stg.scrollTop=s.top; stg.scrollLeft=s.left; } }
// Clicking a diff row jumps to its box. Missing/extra switch to the side that
// shows that text (missing → source, extra → target). A MOVED row does NOT
// switch sides — repeated clicks toggle the glow between where the text sits on
// the source vs where it moved to on the target, both seen on the chosen
// backdrop, so the shift is easy to eyeball.
function onRowClick(row){
  const side=row.dataset.side, i=row.dataset.i;
  if(row.dataset.moved==='1'){
    const it=D.source.find(x=>String(x.i)===String(i)); if(!it) return;
    row._t=((row._t||0)+1)%2;
    glowBox(row._t===1&&it.cx!=null ? {side:'target',x:it.cx,y:it.cy,w:it.cw,h:it.ch} : {side:'source',x:it.x,y:it.y,w:it.w,h:it.h});
    return;
  }
  const it=(side==='source'?D.source:D.target).find(x=>String(x.i)===String(i)); if(!it) return;
  if(bgSide!==side){ bgSide=side; applyView(); }
  glowBox({side,x:it.x,y:it.y,w:it.w,h:it.h});
}
// Locate the crawl trigger that revealed a gated line, so clicking the row can
// glow it and pop up what it exposes. Prefer a trigger whose label matches the
// row's stored "via" label AND whose reveal set contains this text; fall back to
// label-only, then text-only (labels can collide / be absent after attribution).
const gnorm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
function findTrigger(side,label,text){
  const list=(D.triggers&&D.triggers[side])||[]; if(!list.length) return null;
  const ln=gnorm(label), tn=gnorm(text);
  const labelOk=g=>ln&&gnorm(g.label)===ln;
  const textOk=g=>tn&&g.revealed&&g.revealed.some(r=>{const rn=gnorm(r.text); return rn&&(rn.includes(tn)||tn.includes(rn));});
  return list.find(g=>labelOk(g)&&textOk(g))||list.find(labelOk)||list.find(textOk)||null;
}
// Interaction-gated rows: present is recovered via the TARGET crawl (trigger on
// target), missing comes from the SOURCE crawl (trigger on source). Switch to
// that side, scroll the trigger into view, and reuse showReveal to glow it + pop
// up the "via …" reveals — so you land exactly on the element named in the row.
function onGatedRowClick(row){
  const kind=row.dataset.gkind, idx=+row.dataset.gidx;
  const item=D.gated&&D.gated[kind]&&D.gated[kind][idx]; if(!item) return;
  const side=kind==='present'?'target':'source';
  if(bgSide!==side){ bgSide=side; applyView(); }
  const t=findTrigger(side,item.trigger,item.text); if(!t) return;
  el('stage').scrollTo({top:Math.max(0,(t.y+off(side).dy)-140),behavior:'smooth'});
  showReveal(t);
}
function fillSide(){ const s=el('side'); const txt=i=>!i.img;
  const miss=D.source.filter(i=>!i.m&&!i.mv&&txt(i)); const extra=D.target.filter(i=>!i.m&&!i.mv&&txt(i)); const moved=D.source.filter(i=>i.mv);
  const missImg=D.source.filter(i=>!i.m&&!i.mv&&i.img); const extraImg=D.target.filter(i=>!i.m&&!i.mv&&i.img);
  const rows=(arr,cls,side,extra,suffix)=>arr.map(i=>'<div class="row '+cls+'" data-side="'+side+'" data-i="'+i.i+'"'+(extra||'')+' data-y="'+i.y+'">'+i.i+'. '+escapeHtml(i.t)+(suffix?suffix(i):'')+'</div>').join('');
  s.innerHTML='<h4>Missing on target ('+miss.length+')</h4>'+rows(miss,'miss','source','')
    +'<h4>Moved ('+moved.length+')</h4>'+rows(moved,'moved','source',' data-moved="1"',i=>' <small>y'+i.y+'→'+i.cy+'</small>')
    +'<h4>Extra on target ('+extra.length+')</h4>'+rows(extra,'extra','target','')
    +'<h4>Missing images ('+missImg.length+')</h4>'+rows(missImg,'miss','source','')
    +'<h4>Extra images ('+extraImg.length+')</h4>'+rows(extraImg,'extra','target','');
  if(D.gated){
    const grow=(arr,cls,kind)=>arr.map((i,idx)=>'<div class="row '+cls+'" data-gkind="'+kind+'" data-gidx="'+idx+'">'+escapeHtml(i.text.slice(0,70))+(i.trigger?' <small>via “'+escapeHtml(i.trigger.slice(0,26))+'”</small>':'')+'</div>').join('');
    s.innerHTML+='<h4 class="gatedh" title="on target only after an interaction">Interaction-gated, present ('+D.gated.present.length+')</h4>'+grow(D.gated.present,'gated','present')
      +'<h4 class="gatedh" title="source reveals via interaction; target never shows it">Interaction-gated, missing ('+D.gated.missing.length+')</h4>'+grow(D.gated.missing,'gatedmiss','missing');
  }
  s.querySelectorAll('.row[data-side]').forEach(r=>r.onclick=()=>onRowClick(r));
  s.querySelectorAll('.row[data-gkind]').forEach(r=>r.onclick=()=>onGatedRowClick(r));
  const a=D.audit||{};
  el('stat').innerHTML='<small>'+miss.length+' missing · '+moved.length+' moved · '+extra.length+' extra'
    +(a.coverage!=null?' · cov '+(a.coverage*100).toFixed(0)+'%':'')+(a.layoutDriftCount!=null?' · drift '+a.layoutDriftCount:'')
    +(a.imageMatchedCount!=null?' · img '+a.imageMatchedCount+'✓/'+a.imageMissingCount+'✗/'+a.imageExtraCount+'+':'')+'</small>'; }
function escapeHtml(x){return String(x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
el('bSide').onclick=()=>{
  // Switching sides must leave the state view (states are per-side). Keep the SAME
  // scroll position on the other side so you compare the same region — use the live
  // scroll when in base view; fall back to the descend point only when leaving a
  // state view (there the live scroll is in the state backdrop's space, not base's).
  const stg=el('stage');
  // Track scroll in DOC space (minus this side's leftPad) so the same doc region
  // stays in view on the other side, whose hidden-content leftPad usually differs
  // (each side opens at a different slider slide). Set the ABSOLUTE target after the
  // view rebuilds — a += would read a value already clamped by a narrower canvas. #63
  const docX=(!navStack.length && stg)?(stg.scrollLeft-hiddenLeftPad):null;
  const keep=(!navStack.length && stg)?{top:stg.scrollTop,left:stg.scrollLeft}:baseScroll;
  bgSide=bgSide==='source'?'target':'source';
  exitToBase(keep);
  if(stg && !navStack.length && docX!=null) stg.scrollLeft = docX + hiddenLeftPad;
};
if(el('bPear')){
  // In a state view the backdrop is always the captured screenshot; the toggle
  // only affects the base view.
  el('bPear').onclick=()=>{ backdrop='pear'; el('bPear').classList.add('on'); el('bShot').classList.remove('on'); if(navStack.length) showState(); else applyView(); };
  el('bShot').onclick=()=>{ backdrop='shot'; el('bShot').classList.add('on'); el('bPear').classList.remove('on'); if(navStack.length) showState(); else applyView(); };
}
['tSrc','tTgt','tAlign','tMoved','tIdx','tLine','tClick','tReveal'].forEach(id=>el(id).onchange=render);
// Hidden content also resizes the canvas (items flow off the right edge), so it
// re-runs applyView (which recomputes width) rather than just render. Toggling it
// on/off changes the left margin (leftPad) when there are left-flowing hidden
// slides, so keep the SAME content under the viewport by shifting scrollLeft by the
// leftPad delta — otherwise the whole canvas jumps right and you land on empty
// space you'd have to scroll back from. #63
el('tHidden').onchange=()=>{ const stg=el('stage'); const docX=stg?(stg.scrollLeft-hiddenLeftPad):0; applyView(); if(stg && !navStack.length) stg.scrollLeft=docX+hiddenLeftPad; };
el('bReset').onclick=()=>clearSync();
el('bPanel').onclick=()=>{ panelOpen=!panelOpen; el('side').style.display=panelOpen?'block':'none'; el('bPanel').classList.toggle('on',panelOpen); };
el('pop').onclick=(e)=>e.stopPropagation(); // clicks inside the popover keep it open
// Click elsewhere on the stage closes an open popover. AND — in a state view —
// clicking the BACKDROP itself (empty space, not a child box: those stopPropagation)
// steps BACK one level: state → parent → … → base. So you can click down through the
// depths and click anywhere else to unwind, one level per click. A click that merely
// dismisses an open popover doesn't also pop.
el('stage').addEventListener('click',()=>{ const wasOpen=el('pop').style.display==='block'; hidePop(); if(!wasOpen && navStack.length) popTo(navStack.length-1); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') hidePop(); });
computeDrifts(); fillSide();
el('side').style.display=panelOpen?'block':'none'; el('bPanel').classList.toggle('on',panelOpen);
applyView();
</script></body></html>`;
}

module.exports = { buildCanonicalReviewHtml };
