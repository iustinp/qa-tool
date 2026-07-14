/**
 * layout-review-html — a self-contained interactive review page for the
 * text-layout audit. It renders the two full-page screenshots with the
 * source(green)/target(red)/aligned(blue) text boxes, index labels, and
 * reading-order connectors drawn as an SVG overlay, plus a fixed toolbar to
 * switch the background (source ↔ target) and toggle each layer, and a side
 * list of missing / extra text that scrolls the view to the item.
 *
 * The HTML references screenshots/source-full.png and screenshots/target-full.png
 * (relative), so it lives in the pair dir and opens straight in a browser.
 */

function slimItem(it) {
  const o = { i: it.idx, x: it.x, y: it.y, w: it.w, h: it.h, t: it.text, m: !!it.matched };
  if (it.counterpart) {
    o.cx = it.counterpart.x;
    o.cy = it.counterpart.y;
    o.cw = it.counterpart.w;
    o.ch = it.counterpart.h;
  }
  return o;
}

function buildLayoutReviewHtml(o) {
  const data = {
    sourceUrl: o.sourceUrl || '',
    targetUrl: o.targetUrl || '',
    sourceImg: o.sourceImg || 'screenshots/source-full.png',
    targetImg: o.targetImg || 'screenshots/target-full.png',
    sourceDims: o.sourceDims || null,
    targetDims: o.targetDims || null,
    source: (o.alignment?.source || []).map(slimItem),
    target: (o.alignment?.target || []).map(slimItem),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Layout review</title>
<style>
  :root{--src:#00c000;--tgt:#e00000;--align:#0060ff}
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
  #stage{position:relative;flex:1;overflow:auto;height:calc(100vh - 44px)}
  #inner{position:relative}
  #bg{display:block}
  #ov{position:absolute;top:0;left:0;pointer-events:none}
  #side{width:280px;background:#1a1a1a;border-left:1px solid #444;overflow:auto;height:calc(100vh - 44px);padding:6px}
  #side h4{margin:8px 4px 4px;color:#fff}
  .row{padding:3px 6px;border-bottom:1px solid #2a2a2a;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row:hover{background:#2a2a2a}
  .row.miss{color:#8f8}.row.extra{color:#f99}
  small{color:#999}
</style></head><body>
<div id="bar">
  <b>Layout review</b>
  <span class="seg"><button id="bSrc" class="on">Source</button><button id="bTgt">Target</button></span>
  <label><span class="sw" style="background:var(--src)"></span><input type="checkbox" id="tSrc" checked>Source boxes</label>
  <label><span class="sw" style="background:var(--tgt)"></span><input type="checkbox" id="tTgt" checked>Target boxes</label>
  <label><span class="sw" style="background:var(--align)"></span><input type="checkbox" id="tAlign" checked>Aligned</label>
  <label><input type="checkbox" id="tIdx" checked>Indices</label>
  <label><input type="checkbox" id="tLine">Connectors</label>
  <span id="stat"><small></small></span>
</div>
<div id="wrap">
  <div id="stage"><div id="inner"><img id="bg"><svg id="ov" xmlns="http://www.w3.org/2000/svg"></svg></div></div>
  <div id="side"></div>
</div>
<script>
const D=${json};
const SVGNS='http://www.w3.org/2000/svg';
let bgSide='source';
const el=id=>document.getElementById(id);
function iou(a){ if(a.cx==null) return 0;
  const x1=Math.max(a.x,a.cx),y1=Math.max(a.y,a.cy),x2=Math.min(a.x+a.w,a.cx+a.cw),y2=Math.min(a.y+a.h,a.cy+a.ch);
  if(x2<=x1||y2<=y1) return 0; const inter=(x2-x1)*(y2-y1); const uni=a.w*a.h+a.cw*a.ch-inter; return uni>0?inter/uni:0; }
function setBg(side){ bgSide=side; el('bSrc').classList.toggle('on',side==='source'); el('bTgt').classList.toggle('on',side==='target');
  const img=side==='source'?D.sourceImg:D.targetImg; el('bg').src=img; }
el('bg').onload=()=>{ const w=el('bg').naturalWidth,h=el('bg').naturalHeight; const ov=el('ov'); ov.setAttribute('width',w); ov.setAttribute('height',h); ov.setAttribute('viewBox','0 0 '+w+' '+h); el('inner').style.width=w+'px'; render(); };
function box(it,color,side){ const g=document.createElementNS(SVGNS,'g');
  const r=document.createElementNS(SVGNS,'rect'); r.setAttribute('x',it.x);r.setAttribute('y',it.y);r.setAttribute('width',it.w);r.setAttribute('height',it.h);
  r.setAttribute('fill','none');r.setAttribute('stroke',color);r.setAttribute('stroke-width','2'); if(!it.m) r.setAttribute('stroke-dasharray','5 3'); g.appendChild(r);
  if(el('tIdx').checked){ const t=document.createElementNS(SVGNS,'text'); const left=side==='source';
    t.setAttribute('x',left?Math.max(2,it.x-3):Math.min(it.x+it.w+3)); t.setAttribute('y',it.y+Math.min(it.h,13));
    t.setAttribute('font-size','12');t.setAttribute('font-family','monospace');t.setAttribute('font-weight','bold');t.setAttribute('fill',color);t.setAttribute('text-anchor',left?'end':'start'); t.textContent=it.i; g.appendChild(t); }
  return g; }
function line(items,color){ let d=''; for(let i=1;i<items.length;i++){const a=items[i-1],b=items[i]; d+=(i===1?'M':'L')+(a.x+a.w)+' '+(a.y+a.h)+' L'+b.x+' '+b.y+' ';}
  const p=document.createElementNS(SVGNS,'path'); p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',color);p.setAttribute('stroke-width','1');p.setAttribute('opacity','0.5'); return p; }
function render(){ const ov=el('ov'); ov.innerHTML=''; const showAlign=el('tAlign').checked;
  if(el('tLine').checked){ ov.appendChild(line(D.source,'var(--src)')); ov.appendChild(line(D.target,'var(--tgt)')); }
  if(el('tSrc').checked) for(const it of D.source){ const aligned=showAlign&&it.m&&iou(it)>0.4; ov.appendChild(box(it,aligned?'var(--align)':'var(--src)','source')); }
  if(el('tTgt').checked) for(const it of D.target){ const aligned=showAlign&&it.m; if(aligned&&it.cx!=null){/* aligned drawn from source side */} ov.appendChild(box(it,'var(--tgt)','target')); }
}
function fillSide(){ const s=el('side'); const miss=D.source.filter(i=>!i.m); const extra=D.target.filter(i=>!i.m);
  s.innerHTML='<h4>Missing on target ('+miss.length+')</h4>'+miss.map(i=>'<div class="row miss" data-y="'+i.y+'">'+i.i+'. '+escapeHtml(i.t)+'</div>').join('')
    +'<h4>Extra on target ('+extra.length+')</h4>'+extra.map(i=>'<div class="row extra" data-y="'+i.y+'">'+i.i+'. '+escapeHtml(i.t)+'</div>').join('');
  s.querySelectorAll('.row').forEach(r=>r.onclick=()=>{ el('stage').scrollTo({top:Math.max(0,(+r.dataset.y)-100),behavior:'smooth'}); });
  el('stat').innerHTML='<small>'+D.source.length+' source / '+D.target.length+' target texts · '+miss.length+' missing · '+extra.length+' extra</small>'; }
function escapeHtml(x){return String(x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
['bSrc','bTgt'].forEach(id=>el(id).onclick=()=>setBg(id==='bSrc'?'source':'target'));
['tSrc','tTgt','tAlign','tIdx','tLine'].forEach(id=>el(id).onchange=render);
fillSide(); setBg('source');
</script></body></html>`;
}

module.exports = { buildLayoutReviewHtml };
