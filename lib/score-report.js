'use strict';

/**
 * A self-contained, sortable HTML report of every processed pair with its health
 * scores + components. Click any column header to sort (toggle asc/desc); default is
 * worst-first by General Health. Health & Content are higher = better; Drift is lower
 * = better (cells colour-coded accordingly). Each row links to the source page and to
 * that pair's layout-review.html. Rows lacking scores (capture error / no audit) show
 * "—" and sort last.
 *
 * `rows` are the per-pair summary objects (same shape as summary.json `results`):
 * slug, sourceUrl, targetUrl, healthScore, contentScore, driftScore,
 * layoutMatched/Missing/ExtraCount, driftGreen/Yellow/Red, captureError, finishedReason.
 * `meta` = { pairCount, generatedAt }.
 */
const path = require('path');
const fs = require('fs');

function writeScoreReport(outDir, rows, meta) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Map a per-resolution layout-fields object to the report's short row keys.
  const shortFields = (l) =>
    l
      ? {
          health: l.healthScore, content: l.contentScore, drift: l.driftScore,
          matched: l.layoutMatchedCount, missing: l.layoutMissingCount, extra: l.layoutExtraCount,
          g: l.driftGreen, y: l.driftYellow, rd: l.driftRed,
        }
      : {};
  const data = rows.map((r) => ({
    slug: r.slug, src: r.sourceUrl || '', tgt: r.targetUrl || '',
    health: r.healthScore, content: r.contentScore, drift: r.driftScore,
    matched: r.layoutMatchedCount, missing: r.layoutMissingCount, extra: r.layoutExtraCount,
    g: r.driftGreen, y: r.driftYellow, rd: r.driftRed,
    // Per-resolution values (short keys) for the tabs; null when single-resolution.
    bp: r.byProfile
      ? Object.fromEntries(Object.entries(r.byProfile).map(([k, l]) => [k, shortFields(l)]))
      : null,
    err: r.captureError ? 'capture error' : (r.healthScore == null ? (r.finishedReason || 'no audit') : null),
  }));
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const resJson = JSON.stringify(meta.resolutions || null).replace(/</g, '\\u003c');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>QA scores — ${esc(meta.pairCount)} pages</title>
<style>
  body{font:13px/1.45 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#222}
  header{padding:14px 18px;background:#fff;border-bottom:1px solid #ddd}
  h1{margin:0 0 3px;font-size:16px} .sub{color:#777;font-size:12px}
  table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:7px 10px;text-align:right;border-bottom:1px solid #eee;white-space:nowrap}
  thead th{position:sticky;top:0;z-index:3;background:#fafafa;cursor:pointer;user-select:none;border-bottom:2px solid #ccc;vertical-align:bottom}
  th:hover{filter:brightness(0.96)} th.page,td.page{text-align:left;white-space:normal;max-width:560px}
  td.page a{color:#0645ad;text-decoration:none} td.page a:hover{text-decoration:underline}
  td.page .rev{color:#9b30ff;font-size:11px;margin-left:8px}
  th.urls,td.urls{text-align:left;white-space:nowrap} td.urls a{color:#0645ad;text-decoration:none} td.urls a:hover{text-decoration:underline} td.urls .sep{color:#bbb;margin:0 5px}
  .bad{background:#fde2e2;color:#a00;font-weight:600}.mid{background:#fdf3d8;color:#8a6d00}.good{background:#e3f6e3;color:#181}
  .muted{color:#aaa}.arrow{font-size:10px;color:#888;margin-left:3px}
  /* Column groups: content family (blue), drift family (purple); General Health bold. */
  th.hp,td.hp{font-weight:700}
  th.gc{background:#e6eefc}td.gc{background:#f4f8ff}
  th.gd{background:#efe7fb}td.gd{background:#f8f4ff}
  .gstart{border-left:2px solid #b9bccc}
  td.sg{color:#158a15}td.sy{color:#8a6d00}td.sr{color:#c0392b;font-weight:600}
  tr:hover td{filter:brightness(0.97)}
  #tabs{display:flex;gap:6px;flex-wrap:wrap;padding:10px 18px 0;background:#f6f7f9}
  #tabs:empty{display:none}
  .tab{border:1px solid #ccc;border-bottom:none;border-radius:7px 7px 0 0;background:#eceef1;padding:6px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:7px}
  .tab.active{background:#fff;font-weight:600;box-shadow:0 2px 0 #4f8cff inset}
  .tab .rlabel{color:#333}
  .tab .badge{font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px}
  .tab .badge.good{background:#e3f6e3;color:#181}.tab .badge.mid{background:#fdf3d8;color:#8a6d00}.tab .badge.bad{background:#fde2e2;color:#a00}
</style></head><body>
<header><h1>QA scores — ${esc(meta.pairCount)} pages</h1>
<div class="sub">${esc(meta.generatedAt)} · click a column to sort (default: worst General Health first). Health &amp; Content higher = better; Drift lower = better. ⌘/Ctrl-click (or middle-click) a URL to open it in a background tab.</div></header>
<div id="tabs"></div>
<table id="t"><thead><tr>
  <th class="urls" title="open the source / target page (⌘/Ctrl-click or middle-click to open in a background tab)">Pair URLs</th>
  <th class="page" data-k="src" data-t="s">Page</th>
  <th class="hp" data-k="health" title="overall page health — higher is better">General Health %</th>
  <th class="gc gstart" data-k="content" title="content completeness — higher is better">Content Completeness %</th>
  <th class="gc" data-k="matched" title="matched text elements">Matched</th>
  <th class="gc" data-k="missing" title="missing on target">Missing</th>
  <th class="gc" data-k="extra" title="extra on target">Extra</th>
  <th class="gd gstart" data-k="drift" title="drift graded per paragraph but counted per matched text run (re-split blocks and images excluded) — lower is better">Drifting texts %</th>
  <th class="gd" data-k="g" title="small drift (≤20px)">Small Drift</th>
  <th class="gd" data-k="y" title="medium drift (≤40px)">Medium Drift</th>
  <th class="gd" data-k="rd" title="large drift (>40px)">Large Drift</th>
</tr></thead><tbody></tbody></table>
<script>
var ROWS=${json};
var RES=${resJson};                                   // [{name,width,ua,label}] or null (single-res)
var activeRes=(RES&&RES.length)?RES[0].name:null;
var sortK='health', sortDir=1; // asc = worst health first
function cell(v){ return v==null?'<span class="muted">—</span>':v; }
function cls(v,kind){ if(v==null)return''; if(kind==='hi')return v>=80?'good':v>=50?'mid':'bad'; if(kind==='lo')return v<=20?'good':v<=40?'mid':'bad'; return ''; }
function shorten(u){ try{var x=new URL(u);return (x.pathname+(x.search||''))||u;}catch(e){return u;} }
// A row's score object for the active resolution (top-level when single-res).
function vals(r){ return activeRes ? ((r.bp&&r.bp[activeRes])||{}) : r; }
function fieldOf(r,k){ return k==='src' ? r.src : vals(r)[k]; }
function render(){
  var rows=ROWS.slice().sort(function(a,b){ var av=fieldOf(a,sortK),bv=fieldOf(b,sortK);
    if(av==null&&bv==null)return 0; if(av==null)return 1; if(bv==null)return -1;
    if(typeof av==='string')return sortDir*String(av).localeCompare(String(bv));
    return sortDir*(av-bv); });
  var reviewFile=activeRes?('layout-review-'+activeRes+'.html'):'layout-review.html';
  var tb=document.querySelector('#t tbody'); tb.innerHTML='';
  rows.forEach(function(r){ var tr=document.createElement('tr'); var v=vals(r);
    var rev=r.slug?' <a class="rev" href="pairs/'+r.slug+'/'+reviewFile+'">review ↗</a>':'';
    tr.innerHTML='<td class="urls"><a class="pl" href="'+r.src+'" target="_blank" rel="noopener">Source</a><span class="sep">·</span><a class="pl" href="'+r.tgt+'" target="_blank" rel="noopener">Target</a></td>'
      +'<td class="page">'+shorten(r.src||r.tgt)+rev+(r.err?' <span class="muted">('+r.err+')</span>':'')+'</td>'
      +'<td class="hp '+cls(v.health,'hi')+'">'+cell(v.health)+'</td>'
      +'<td class="gstart '+cls(v.content,'hi')+'">'+cell(v.content)+'</td>'
      +'<td class="gc">'+cell(v.matched)+'</td><td class="gc">'+cell(v.missing)+'</td><td class="gc">'+cell(v.extra)+'</td>'
      +'<td class="gstart '+cls(v.drift,'lo')+'">'+cell(v.drift)+'</td>'
      +'<td class="gd sg">'+cell(v.g)+'</td><td class="gd sy">'+cell(v.y)+'</td><td class="gd sr">'+cell(v.rd)+'</td>';
    tb.appendChild(tr); });
  document.querySelectorAll('#t th').forEach(function(th){ var base=th.getAttribute('data-base')||th.textContent.replace(/\\s*[▲▼]$/,'').trim(); th.setAttribute('data-base',base);
    th.innerHTML=base+(th.getAttribute('data-k')===sortK?' <span class="arrow">'+(sortDir>0?'▲':'▼')+'</span>':''); });
}
// One tab per resolution; the badge shows that resolution's WORST general health
// (min across pages), coloured, so a bad breakpoint stands out at a glance.
function renderTabs(){
  var el=document.getElementById('tabs'); if(!el)return;
  if(!RES||!RES.length){ el.innerHTML=''; return; }
  el.innerHTML='';
  RES.forEach(function(res){
    var worst=null;
    ROWS.forEach(function(r){ var h=r.bp&&r.bp[res.name]&&r.bp[res.name].health; if(h!=null) worst=(worst==null)?h:Math.min(worst,h); });
    var badge=worst==null?'':' <span class="badge '+cls(worst,'hi')+'">'+worst+'%</span>';
    var b=document.createElement('div'); b.className='tab'+(res.name===activeRes?' active':'');
    b.innerHTML='<span class="rlabel">'+res.label+'</span>'+badge;
    b.onclick=function(){ activeRes=res.name; renderTabs(); render(); };
    el.appendChild(b);
  });
}
document.querySelectorAll('#t th').forEach(function(th){ th.onclick=function(){ var k=th.getAttribute('data-k'); if(!k)return; if(k===sortK)sortDir=-sortDir; else{sortK=k;sortDir=1;} render(); }; });
renderTabs();
render();
</script></body></html>`;
  const p = path.join(outDir, 'report.html');
  fs.writeFileSync(p, html);
  return p;
}

module.exports = { writeScoreReport };
