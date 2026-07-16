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
  return o;
}

function buildCanonicalReviewHtml(o) {
  const data = {
    sourceUrl: o.sourceUrl || '',
    targetUrl: o.targetUrl || '',
    sourceDims: o.sourceDims || { w: 1920, h: 1080 },
    targetDims: o.targetDims || { w: 1920, h: 1080 },
    sourceImg: o.sourceImg || null,
    targetImg: o.targetImg || null,
    source: (o.alignment?.source || []).map(slimItem),
    target: (o.alignment?.target || []).map(slimItem),
    audit: o.audit || null,
  };
  const hasShots = !!(data.sourceImg && data.targetImg);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const srcCanvas = renderPearNodes(o.sourceClm);
  const tgtCanvas = renderPearNodes(o.targetClm);
  // Load both pages' web fonts so each pear renders in its real typeface.
  const fonts = {
    faces: [o.sourceClm?.fonts?.faces, o.targetClm?.fonts?.faces].filter(Boolean).join('\n'),
    links: [...new Set([...(o.sourceClm?.fonts?.links || []), ...(o.targetClm?.fonts?.links || [])])],
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Canonical layout review</title>
${fontHead(fonts)}
<style>
  :root{--src:#00a000;--tgt:#e00000;--align:#0060ff;--moved:#ff8800}
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
  #stage{position:relative;flex:1;overflow:auto;height:calc(100vh - 44px);background:#fff}
  #inner{position:relative}
  .pear{position:absolute;top:0;left:0;background:#fff}
  #shot{position:absolute;top:0;left:0;z-index:1;display:none}
  #ov{position:absolute;top:0;left:0;z-index:2;pointer-events:none}
  #side{width:290px;background:#1a1a1a;border-left:1px solid #444;overflow:auto;height:calc(100vh - 44px);padding:6px}
  #side h4{margin:8px 4px 4px;color:#fff}
  .row{padding:3px 6px;border-bottom:1px solid #2a2a2a;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row:hover{background:#2a2a2a}
  .row.miss{color:#8f8}.row.extra{color:#f99}.row.moved{color:#fb0}
  small{color:#999}
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
  <span id="connLegend" style="display:none"><small>drift
    <span class="sw" style="background:#22c55e"></span>&le;20
    <span class="sw" style="background:#eab308"></span>&le;40
    <span class="sw" style="background:#ef4444"></span>&gt;40</small></span>
  <button id="bReset" style="display:none;background:#333;color:#ddd;border:1px solid #555;padding:4px 10px;cursor:pointer">Reset align</button>
  <span id="stat"><small></small></span>
</div>
<div id="wrap">
  <div id="stage"><div id="inner">
    <div class="pear" id="pearSrc">${srcCanvas}</div>
    <div class="pear" id="pearTgt" style="display:none">${tgtCanvas}</div>
    <img id="shot" alt="">
    <svg id="ov" xmlns="http://www.w3.org/2000/svg"></svg>
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
const el=id=>document.getElementById(id);
const off=side=>(syncShift&&syncShift.side===side)?syncShift:{dx:0,dy:0};
// Translate each side's backdrop by its sync offset, so the shifted side's
// pear/screenshot moves with its boxes and stays registered at the anchor when
// you toggle sides.
function tr(o){ return 'translate('+o.dx+'px,'+o.dy+'px)'; }
function positionBackdrops(){ el('pearSrc').style.transform=tr(off('source')); el('pearTgt').style.transform=tr(off('target')); el('shot').style.transform=tr(off(bgSide)); }
// Combine chosen side (source/target) with chosen backdrop (pear/screenshot).
function applyView(){
  el('bSide').textContent=bgSide==='source'?'SOURCE / target':'source / TARGET';
  if(el('bPear')){ el('bPear').classList.toggle('on',backdrop==='pear'); el('bShot').classList.toggle('on',backdrop==='shot'); }
  const pear=backdrop==='pear';
  el('pearSrc').style.display=(pear&&bgSide==='source')?'block':'none';
  el('pearTgt').style.display=(pear&&bgSide==='target')?'block':'none';
  const d=bgSide==='source'?D.sourceDims:D.targetDims;
  const shot=el('shot');
  if(!pear){ shot.style.display='block'; shot.style.width=d.w+'px'; shot.src=(bgSide==='source'?D.sourceImg:D.targetImg); }
  else shot.style.display='none';
  el('inner').style.width=d.w+'px'; el('inner').style.height=d.h+'px';
  const ov=el('ov'); ov.setAttribute('width',d.w); ov.setAttribute('height',d.h); ov.setAttribute('viewBox','0 0 '+d.w+' '+d.h);
  positionBackdrops(); render();
}
function box(it,color,side){ const g=document.createElementNS(SVGNS,'g');
  const o=off(side); const bx=it.x+o.dx, by=it.y+o.dy;
  const anchor=syncAnchor&&syncAnchor.side===side&&syncAnchor.i===it.i;
  const r=document.createElementNS(SVGNS,'rect'); r.setAttribute('x',bx);r.setAttribute('y',by);r.setAttribute('width',it.w);r.setAttribute('height',it.h);
  r.setAttribute('fill','none');r.setAttribute('stroke',color);r.setAttribute('stroke-width',anchor?'3.5':'2'); if(!it.m) r.setAttribute('stroke-dasharray','5 3');
  // Only the currently-viewed side is clickable, so overlapping boxes from the
  // other side never intercept the click.
  if(side===bgSide){ r.setAttribute('pointer-events','all'); r.style.cursor='pointer'; r.onclick=()=>syncTo(it,side); }
  g.appendChild(r);
  if(el('tIdx').checked){ const t=document.createElementNS(SVGNS,'text'); const left=side==='source';
    t.setAttribute('x',left?Math.max(2,bx-3):bx+it.w+3); t.setAttribute('y',by+Math.min(it.h,13));
    t.setAttribute('font-size','12');t.setAttribute('font-family','monospace');t.setAttribute('font-weight','bold');t.setAttribute('fill',color);t.setAttribute('text-anchor',left?'end':'start'); t.textContent=it.i; g.appendChild(t); }
  return g; }
// Pin the clicked box: translate the OTHER side so this pair's counterpart sits
// on top of it, then re-render (connectors follow). Clicking an unpaired box
// (missing/extra) clears the sync.
function syncTo(it,side){
  if(it.cx==null){ syncShift=null; syncAnchor=null; el('bReset').style.display='none'; positionBackdrops(); render(); return; }
  const other=side==='source'?'target':'source';
  syncShift={side:other,dx:it.x-it.cx,dy:it.y-it.cy}; syncAnchor={side,i:it.i};
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
function connector(it){ const so=off('source'), to=off('target'); const p=document.createElementNS(SVGNS,'line');
  p.setAttribute('x1',it.x+so.dx);p.setAttribute('y1',it.y+so.dy);p.setAttribute('x2',it.cx+to.dx);p.setAttribute('y2',it.cy+to.dy);
  p.setAttribute('stroke',connColor(it));p.setAttribute('stroke-width','1.5');
  p.setAttribute('opacity','0.65'); return p; }
function render(){ const ov=el('ov'); ov.innerHTML=''; const showAlign=el('tAlign').checked; const showMoved=el('tMoved').checked;
  const lines=el('tLine').checked; el('connLegend').style.display=lines?'inline':'none';
  // Connectors first (under the boxes): one per index that has a counterpart.
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
}
function fillSide(){ const s=el('side'); const miss=D.source.filter(i=>!i.m&&!i.mv); const extra=D.target.filter(i=>!i.m&&!i.mv); const moved=D.source.filter(i=>i.mv);
  const rows=(arr,cls,suffix)=>arr.map(i=>'<div class="row '+cls+'" data-y="'+i.y+'">'+i.i+'. '+escapeHtml(i.t)+(suffix?suffix(i):'')+'</div>').join('');
  s.innerHTML='<h4>Missing on target ('+miss.length+')</h4>'+rows(miss,'miss')
    +'<h4>Moved ('+moved.length+')</h4>'+rows(moved,'moved',i=>' <small>y'+i.y+'→'+i.cy+'</small>')
    +'<h4>Extra on target ('+extra.length+')</h4>'+rows(extra,'extra');
  s.querySelectorAll('.row').forEach(r=>r.onclick=()=>{ el('stage').scrollTo({top:Math.max(0,(+r.dataset.y)-100),behavior:'smooth'}); });
  const a=D.audit||{};
  el('stat').innerHTML='<small>'+D.source.length+' src / '+D.target.length+' tgt · '+miss.length+' missing · '+moved.length+' moved · '+extra.length+' extra'
    +(a.coverage!=null?' · coverage '+(a.coverage*100).toFixed(0)+'%':'')+(a.layoutDriftCount!=null?' · drift '+a.layoutDriftCount:'')+'</small>'; }
function escapeHtml(x){return String(x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
el('bSide').onclick=()=>{ bgSide=bgSide==='source'?'target':'source'; applyView(); };
if(el('bPear')){ el('bPear').onclick=()=>{ backdrop='pear'; applyView(); }; el('bShot').onclick=()=>{ backdrop='shot'; applyView(); }; }
['tSrc','tTgt','tAlign','tMoved','tIdx','tLine'].forEach(id=>el(id).onchange=render);
el('bReset').onclick=()=>{ syncShift=null; syncAnchor=null; el('bReset').style.display='none'; positionBackdrops(); render(); };
computeDrifts(); fillSide(); applyView();
</script></body></html>`;
}

module.exports = { buildCanonicalReviewHtml };
