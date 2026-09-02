'use strict';

/**
 * CUSTOMER-Report.html — a trimmed, customer-facing version of report.html (named in all-caps
 * so it is never confused with the internal report). Columns:
 *   - Pair URLs: "Original page" (source) · "Edge Delivery page" (target)
 *   - Page: the page path (NO review link)
 *   - Content Completeness % (same score as the internal report)
 *   - Mismatches: missing + extra count, as a CLICKABLE link -> opens a modal listing the actual
 *     text elements, two columns: "Only on Original page" (missing on target) and
 *     "Only on Edge Delivery page" (extra on target) — the same elements as the review's Diffs.
 * Each modal cell has a Copy button (Clipboard API with an execCommand fallback so it also works
 * from file://) and double-click selects the cell's text.
 *
 * The missing/extra TEXT lives per pair in <outDir>/pairs/<slug>/layout-audit.json (missing[]/
 * extra[], each {text,...}); summary rows only carry counts, so we read those files here — which
 * means this also works from scripts/regen-report.js against a completed run on disk.
 *
 * `rows` = per-pair summary objects (summary.json `results`): slug, sourceUrl, targetUrl,
 * contentScore, layoutMissingCount, layoutExtraCount, captureError, finishedReason.
 */
const path = require('path');
const fs = require('fs');

function readDiffTexts(outDir, slug) {
  if (!slug) return { miss: [], extra: [] };
  try {
    const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'pairs', slug, 'layout-audit.json'), 'utf8'));
    const pick = (a) => (Array.isArray(a) ? a.map((e) => (e && e.text != null ? String(e.text) : '')).filter((t) => t.trim()) : []);
    return { miss: pick(audit.missing), extra: pick(audit.extra) };
  } catch { return { miss: [], extra: [] }; }
}

function writeCustomerReport(outDir, rows, meta) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const data = rows.map((r) => {
    const { miss, extra } = readDiffTexts(outDir, r.slug);
    return {
      src: r.sourceUrl || '', tgt: r.targetUrl || '',
      content: r.contentScore == null ? null : r.contentScore,
      miss, extra, mismatches: miss.length + extra.length,
      err: r.captureError ? 'capture error' : (r.contentScore == null ? (r.finishedReason || 'no audit') : null),
    };
  });
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Migration QA — customer report (${esc(meta.pairCount)} pages)</title>
<style>
  body{font:13px/1.45 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#222}
  header{padding:14px 18px;background:#fff;border-bottom:1px solid #ddd}
  h1{margin:0 0 3px;font-size:16px} .sub{color:#777;font-size:12px}
  table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:7px 10px;text-align:right;border-bottom:1px solid #eee;white-space:nowrap}
  thead th{position:sticky;top:0;z-index:3;background:#fafafa;cursor:pointer;user-select:none;border-bottom:2px solid #ccc;vertical-align:bottom}
  th:hover{filter:brightness(0.96)}
  th.page,td.page{text-align:left;white-space:normal;max-width:620px}
  th.urls,td.urls{text-align:left;white-space:nowrap} td.urls a{color:#0645ad;text-decoration:none} td.urls a:hover{text-decoration:underline} td.urls .sep{color:#bbb;margin:0 5px}
  .bad{background:#fde2e2;color:#a00;font-weight:600}.mid{background:#fdf3d8;color:#8a6d00}.good{background:#e3f6e3;color:#181}
  .muted{color:#aaa}.arrow{font-size:10px;color:#888;margin-left:3px}
  td.mm a{color:#0645ad;font-weight:600;cursor:pointer;text-decoration:none} td.mm a:hover{text-decoration:underline}
  td.mm .zero{color:#181;font-weight:600}
  tr:hover td{filter:brightness(0.97)}
  /* modal */
  #ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:20}
  #md{position:absolute;top:5vh;left:50%;transform:translateX(-50%);width:min(1000px,94vw);max-height:88vh;
      background:#fff;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.35);display:flex;flex-direction:column}
  #mh{padding:12px 16px;border-bottom:1px solid #e5e5e5;display:flex;justify-content:space-between;align-items:center}
  #mh b{font-size:14px} #mx{cursor:pointer;border:0;background:#eee;border-radius:5px;padding:4px 10px;font-size:14px}
  #mb{overflow:auto;padding:0}
  table.diff{width:100%;border-collapse:collapse}
  table.diff th{position:sticky;top:0;background:#fafafa;text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;font-size:12px}
  table.diff th.o{color:#a04100}table.diff th.e{color:#0a6}
  table.diff td{vertical-align:top;text-align:left;white-space:normal;border-bottom:1px solid #f0f0f0;padding:0;width:50%}
  .cellwrap{display:flex;align-items:flex-start;gap:6px;padding:5px 10px}
  .cellwrap .tx{flex:1;user-select:all;cursor:text;word-break:break-word}
  .cellwrap .cp{flex:0 0 auto;border:1px solid #cfcfcf;background:#f7f7f7;border-radius:4px;font-size:11px;padding:1px 6px;cursor:pointer;color:#555}
  .cellwrap .cp:hover{background:#eee} .cellwrap .cp.ok{background:#d8f5d8;border-color:#8ad08a;color:#181}
  td.emptyc{background:#fbfbfb}
</style></head><body>
<header><h1>Migration QA report — ${esc(meta.pairCount)} pages</h1>
<div class="sub">${esc(meta.generatedAt)} · click a column to sort · click a <b>Mismatches</b> number to see the exact text found on only one of the two pages.</div></header>
<table id="t"><thead><tr>
  <th class="urls">Pair URLs</th>
  <th class="page" data-k="src" data-t="s">Page</th>
  <th data-k="content" title="content completeness — higher is better">Content Completeness %</th>
  <th data-k="mismatches" title="text found on only one page (missing + extra) — lower is better">Mismatches</th>
</tr></thead><tbody></tbody></table>

<div id="ov"><div id="md">
  <div id="mh"><b id="mt"></b><button id="mx" onclick="closeM()">✕ Close</button></div>
  <div id="mb"></div>
</div></div>

<script>
var ROWS=${json};
var sortK='mismatches', sortDir=-1; // worst (most mismatches) first
function cell(v){ return v==null?'<span class="muted">—</span>':v; }
function clsHi(v){ if(v==null)return''; return v>=80?'good':v>=50?'mid':'bad'; }
function shorten(u){ try{var x=new URL(u);return (x.pathname+(x.search||''))||u;}catch(e){return u;} }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

function render(){
  var rows=ROWS.map(function(r,i){r._i=i;return r;}).slice().sort(function(a,b){ var av=a[sortK],bv=b[sortK];
    if(av==null&&bv==null)return 0; if(av==null)return 1; if(bv==null)return -1;
    if(typeof av==='string')return sortDir*String(av).localeCompare(String(bv));
    return sortDir*(av-bv); });
  var tb=document.querySelector('#t tbody'); tb.innerHTML='';
  rows.forEach(function(r){ var tr=document.createElement('tr');
    var mm = r.err ? '<span class="muted">—</span>'
      : (r.mismatches>0 ? '<a onclick="openM('+r._i+')">'+r.mismatches+'</a>' : '<span class="zero">0</span>');
    tr.innerHTML='<td class="urls"><a href="'+esc(r.src)+'" target="_blank" rel="noopener">Original page</a><span class="sep">·</span><a href="'+esc(r.tgt)+'" target="_blank" rel="noopener">Edge Delivery page</a></td>'
      +'<td class="page">'+esc(shorten(r.src||r.tgt))+(r.err?' <span class="muted">('+esc(r.err)+')</span>':'')+'</td>'
      +'<td class="'+clsHi(r.content)+'">'+cell(r.content)+'</td>'
      +'<td class="mm">'+mm+'</td>';
    tb.appendChild(tr); });
  document.querySelectorAll('#t th').forEach(function(th){ var base=th.getAttribute('data-base')||th.textContent.replace(/\\s*[▲▼]$/,'').trim(); th.setAttribute('data-base',base);
    th.innerHTML=base+(th.getAttribute('data-k')===sortK?' <span class="arrow">'+(sortDir>0?'▲':'▼')+'</span>':''); });
}
document.querySelectorAll('#t th').forEach(function(th){ th.onclick=function(){ var k=th.getAttribute('data-k'); if(!k)return; if(k===sortK)sortDir=-sortDir; else{sortK=k;sortDir=(k==='mismatches'?-1:1);} render(); }; });

function copyText(txt,btn){
  function done(){ btn.classList.add('ok'); var t=btn.textContent; btn.textContent='copied'; setTimeout(function(){btn.classList.remove('ok');btn.textContent=t;},1000); }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(done,function(){execCopy(txt,done);}); }
  else execCopy(txt,done);
}
function execCopy(txt,done){ var ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select();
  try{document.execCommand('copy');done();}catch(e){} document.body.removeChild(ta); }
function diffCell(txt){
  if(!txt) return '<td class="emptyc"></td>';
  return '<td><div class="cellwrap"><span class="tx" ondblclick="selectCell(this)">'+esc(txt)+'</span>'
    +'<button class="cp" onclick="copyText(this.parentNode.querySelector(\\'.tx\\').textContent,this)">copy</button></div></td>';
}
function selectCell(el){ var r=document.createRange(); r.selectNodeContents(el); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }

function openM(i){ var r=ROWS[i];
  document.getElementById('mt').textContent=shorten(r.src||r.tgt)+' — '+r.mismatches+' mismatches';
  var n=Math.max(r.miss.length,r.extra.length);
  var h='<table class="diff"><thead><tr><th class="o">Only on Original page ('+r.miss.length+')</th><th class="e">Only on Edge Delivery page ('+r.extra.length+')</th></tr></thead><tbody>';
  for(var k=0;k<n;k++){ h+='<tr>'+diffCell(r.miss[k])+diffCell(r.extra[k])+'</tr>'; }
  h+='</tbody></table>';
  document.getElementById('mb').innerHTML=h;
  document.getElementById('ov').style.display='block';
}
function closeM(){ document.getElementById('ov').style.display='none'; }
document.getElementById('ov').onclick=function(e){ if(e.target===this) closeM(); };
document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeM(); });
render();
</script></body></html>`;

  const p = path.join(outDir, 'CUSTOMER-Report.html');
  fs.writeFileSync(p, html);
  return p;
}

module.exports = { writeCustomerReport };
