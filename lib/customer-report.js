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

// Read the missing/extra text lists from a pair's layout-audit file. `file`
// defaults to the primary; multi-res passes layout-audit-<name>.json per resolution.
function readDiffTexts(outDir, slug, file = 'layout-audit.json') {
  if (!slug) return { miss: [], extra: [] };
  try {
    const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'pairs', slug, file), 'utf8'));
    const pick = (a) => (Array.isArray(a) ? a.map((e) => (e && e.text != null ? String(e.text) : '')).filter((t) => t.trim()) : []);
    return { miss: pick(audit.missing), extra: pick(audit.extra) };
  } catch { return { miss: [], extra: [] }; }
}

function writeCustomerReport(outDir, rows, meta) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const resolutions = Array.isArray(meta.resolutions) && meta.resolutions.length ? meta.resolutions : null;
  const data = rows.map((r) => {
    const { miss, extra } = readDiffTexts(outDir, r.slug); // primary (single-res default)
    const row = {
      src: r.sourceUrl || '', tgt: r.targetUrl || '',
      content: r.contentScore == null ? null : r.contentScore,
      miss, extra, mismatches: miss.length + extra.length,
      err: r.captureError ? 'capture error' : (r.contentScore == null ? (r.finishedReason || 'no audit') : null),
    };
    if (resolutions) {
      row.bp = {};
      for (const res of resolutions) {
        const d = readDiffTexts(outDir, r.slug, `layout-audit-${res.name}.json`);
        const c = r.byProfile && r.byProfile[res.name] ? r.byProfile[res.name].contentScore : null;
        row.bp[res.name] = { content: c == null ? null : c, miss: d.miss, extra: d.extra, mismatches: d.miss.length + d.extra.length };
      }
    }
    return row;
  });
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const resJson = JSON.stringify(resolutions).replace(/</g, '\\u003c');

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
  /* whole-row hover + a persistent "last opened" mark (deeper), tinted over any cell colour */
  #t tbody tr:hover td{background-image:linear-gradient(rgba(59,130,246,.10),rgba(59,130,246,.10))}
  #t tbody tr.lastopened td{background-image:linear-gradient(rgba(59,130,246,.24),rgba(59,130,246,.24))}
  #t tbody tr.lastopened:hover td{background-image:linear-gradient(rgba(59,130,246,.30),rgba(59,130,246,.30))}
  #t tbody tr.lastopened td:first-child{box-shadow:inset 3px 0 0 #2f6bd6}
  /* modal */
  #ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:20}
  #md{position:absolute;top:5vh;left:50%;transform:translateX(-50%);width:min(1200px,95vw);max-height:88vh;
      background:#fff;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.35);display:flex;flex-direction:column}
  #mh{padding:12px 16px;border-bottom:1px solid #e5e5e5;display:flex;justify-content:space-between;align-items:center}
  #mh b{font-size:14px} #mx{cursor:pointer;border:0;background:#eee;border-radius:5px;padding:4px 10px;font-size:14px}
  #mb{overflow:auto;padding:0}
  /* two separate tables, side by side with a gap so their rows are visibly independent */
  .tables{display:flex;flex-wrap:wrap;gap:26px;padding:14px 16px;align-items:flex-start}
  .tables>table.diff{flex:1 1 340px;min-width:0}
  table.diff{table-layout:fixed;width:100%;border-collapse:collapse;background:#fff;box-shadow:0 0 0 1px #ececec;border-radius:6px;overflow:hidden}
  table.diff th{position:sticky;top:0;background:#fafafa;text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;font-size:12px}
  table.diff th.o{color:#a04100}table.diff th.e{color:#0a6}table.diff th.cm{color:#555;width:40%}
  table.diff td{vertical-align:top;text-align:left;white-space:normal;border-bottom:1px solid #f0f0f0;padding:0}
  table.diff td.cmc{padding:4px 8px;width:40%}
  .cellwrap{display:flex;align-items:flex-start;gap:6px;padding:5px 10px}
  .cellwrap .tx{flex:1;user-select:all;cursor:text;word-break:break-word}
  .cellwrap .cp{flex:0 0 auto;border:1px solid #cfcfcf;background:#f7f7f7;border-radius:4px;font-size:11px;padding:1px 6px;cursor:pointer;color:#555}
  .cellwrap .cp:hover{background:#eee} .cellwrap .cp.ok{background:#d8f5d8;border-color:#8ad08a;color:#181}
  td.emptyc{background:#fbfbfb}
  .cm-in{width:100%;box-sizing:border-box;min-height:34px;resize:vertical;border:1px solid #d5d5d5;border-radius:4px;font:12px/1.4 system-ui,sans-serif;padding:4px 6px;color:#222;background:#fffef7}
  .cm-in:focus{outline:2px solid #9db8ff;outline-offset:-1px;border-color:#9db8ff;background:#fff}
  #msave{cursor:pointer;border:1px solid #2f7d32;background:#e7f6e7;color:#1a651d;border-radius:5px;padding:4px 10px;font-size:13px;font-weight:600}
  #msave:hover{background:#d8f0d8} #msave.dirty{background:#fff3cd;border-color:#c79100;color:#8a6d00}
  #mh .btns{display:flex;gap:8px;align-items:center}
  #tabs{display:flex;gap:6px;flex-wrap:wrap;padding:10px 18px 0;background:#f6f7f9}
  #tabs:empty{display:none}
  .tab{border:1px solid #ccc;border-bottom:none;border-radius:7px 7px 0 0;background:#eceef1;padding:6px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:7px}
  .tab.active{background:#fff;font-weight:600;box-shadow:0 2px 0 #4f8cff inset}
  .tab .rlabel{color:#333}
  .tab .badge{font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px}
  .tab .badge.good{background:#e3f6e3;color:#181}.tab .badge.mid{background:#fdf3d8;color:#8a6d00}.tab .badge.bad{background:#fde2e2;color:#a00}
</style></head><body>
<header><h1>Migration QA report — ${esc(meta.pairCount)} pages</h1>
<div class="sub">${esc(meta.generatedAt)} · click a column to sort · click a <b>Mismatches</b> number to see the exact text found on only one of the two pages.</div></header>
<div id="tabs"></div>
<table id="t"><thead><tr>
  <th class="urls">Pair URLs</th>
  <th class="page" data-k="src" data-t="s">Page</th>
  <th data-k="content" title="content completeness — higher is better">Content Completeness %</th>
  <th data-k="mismatches" title="text found on only one page (missing + extra) — lower is better">Mismatches</th>
</tr></thead><tbody></tbody></table>

<div id="ov"><div id="md">
  <div id="mh"><b id="mt"></b>
    <div class="btns">
      <button id="msave" onclick="saveFile()" title="Download a copy of this HTML file with your comments saved inside it">💾 Save copy with comments</button>
      <button id="mx" onclick="closeM()">✕ Close</button>
    </div>
  </div>
  <div id="mb"></div>
</div></div>
<script id="comments-data" type="application/json">{}</script>

<script>
var ROWS=${json};
var RES=${resJson};                                  // [{name,width,ua,label}] or null (single-res)
var activeRes=(RES&&RES.length)?RES[0].name:null;
// A row's active-resolution view (top-level when single-res).
function vals(r){ return activeRes ? ((r.bp&&r.bp[activeRes])||{miss:[],extra:[],content:null,mismatches:0}) : r; }
function fieldOf(r,k){ return k==='src' ? r.src : vals(r)[k]; }
var sortK='mismatches', sortDir=-1; // worst (most mismatches) first
var LASTOPENED=null; // original index of the row whose modal was opened last (stays highlighted)
// Comments are persisted INSIDE this file: kept in memory keyed by pair|side|row,
// serialized into the #comments-data script block, and re-read when the file is reopened.
var COMMENTS={}, DIRTY=false;
try{ COMMENTS=JSON.parse(document.getElementById('comments-data').textContent||'{}')||{}; }catch(e){ COMMENTS={}; }
function cell(v){ return v==null?'<span class="muted">—</span>':v; }
function clsHi(v){ if(v==null)return''; return v>=80?'good':v>=50?'mid':'bad'; }
function shorten(u){ try{var x=new URL(u);return (x.pathname+(x.search||''))||u;}catch(e){return u;} }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

function render(){
  var rows=ROWS.map(function(r,i){r._i=i;return r;}).slice().sort(function(a,b){ var av=fieldOf(a,sortK),bv=fieldOf(b,sortK);
    if(av==null&&bv==null)return 0; if(av==null)return 1; if(bv==null)return -1;
    if(typeof av==='string')return sortDir*String(av).localeCompare(String(bv));
    return sortDir*(av-bv); });
  var tb=document.querySelector('#t tbody'); tb.innerHTML='';
  rows.forEach(function(r){ var tr=document.createElement('tr'); var v=vals(r);
    tr.setAttribute('data-i',r._i); if(r._i===LASTOPENED) tr.className='lastopened';
    var mm = r.err ? '<span class="muted">—</span>'
      : (v.mismatches>0 ? '<a onclick="openM('+r._i+')">'+v.mismatches+'</a>' : '<span class="zero">0</span>');
    tr.innerHTML='<td class="urls"><a href="'+esc(r.src)+'" target="_blank" rel="noopener">Original page</a><span class="sep">·</span><a href="'+esc(r.tgt)+'" target="_blank" rel="noopener">Edge Delivery page</a></td>'
      +'<td class="page">'+esc(shorten(r.src||r.tgt))+(r.err?' <span class="muted">('+esc(r.err)+')</span>':'')+'</td>'
      +'<td class="'+clsHi(v.content)+'">'+cell(v.content)+'</td>'
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

function commentCell(i,side,k){
  // Resolution-scoped key when multi-res, so each tab keeps its own comments;
  // single-res keeps the original key (older saved reports still load).
  var key=(activeRes ? i+'|'+activeRes+'|'+side+'|'+k : i+'|'+side+'|'+k), val=COMMENTS[key]||'';
  return '<td class="cmc"><textarea class="cm-in" rows="1" data-key="'+key+'" oninput="onComment(this)" placeholder="Add a comment…">'+esc(val)+'</textarea></td>';
}
function onComment(t){ var v=t.value, key=t.getAttribute('data-key');
  if(v) COMMENTS[key]=v; else delete COMMENTS[key];
  markDirty();
}
function markDirty(){ DIRTY=true; var b=document.getElementById('msave'); if(b) b.classList.add('dirty'); }
// One standalone table (text column + Comments column) for one side of the pair.
function oneTable(i,side,title,arr){
  var h='<table class="diff"><thead><tr><th class="'+side+'">'+esc(title)+' ('+arr.length+')</th><th class="cm">Comments</th></tr></thead><tbody>';
  if(!arr.length){ h+='<tr><td class="emptyc"></td><td class="emptyc"></td></tr>'; }
  for(var k=0;k<arr.length;k++){ h+='<tr>'+diffCell(arr[k])+commentCell(i,side,k)+'</tr>'; }
  return h+'</tbody></table>';
}
function openM(i){ var r=ROWS[i]; var v=vals(r);
  LASTOPENED=i;
  document.querySelectorAll('#t tbody tr').forEach(function(tr){ tr.classList.toggle('lastopened', +tr.getAttribute('data-i')===LASTOPENED); });
  var resLabel=activeRes?(' @ '+resLabelFor(activeRes)):'';
  document.getElementById('mt').textContent=shorten(r.src||r.tgt)+resLabel+' — '+v.mismatches+' mismatches';
  document.getElementById('mb').innerHTML='<div class="tables">'
    +oneTable(i,'o','Only on Original page',v.miss)
    +oneTable(i,'e','Only on Edge Delivery page',v.extra)
    +'</div>';
  document.getElementById('ov').style.display='block';
}
function resLabelFor(name){ if(!RES)return name; for(var j=0;j<RES.length;j++){ if(RES[j].name===name)return RES[j].label; } return name; }
function closeM(){ document.getElementById('ov').style.display='none'; }

// Save = write current comments into the embedded data block, then download the whole
// document as a fresh .html. Nothing is stored outside the file; reopening it restores comments.
function saveFile(){
  var data=document.getElementById('comments-data');
  data.textContent=JSON.stringify(COMMENTS).replace(/</g,'\\u003c');
  var wasOpen=document.getElementById('ov').style.display==='block';
  var mb=document.getElementById('mb'), body=mb.innerHTML;
  mb.innerHTML=''; document.getElementById('ov').style.display='none'; // don't serialize transient modal state
  var html='<!doctype html>\\n'+document.documentElement.outerHTML;
  if(wasOpen){ mb.innerHTML=body; document.getElementById('ov').style.display='block'; }
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([html],{type:'text/html'}));
  a.download=(location.pathname.split('/').pop()||'CUSTOMER-Report.html');
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); },1500);
  DIRTY=false; var b=document.getElementById('msave'); b.classList.remove('dirty');
  var t=b.textContent; b.textContent='✓ Saved — replace the original file with the download'; setTimeout(function(){ b.textContent=t; },2600);
}
window.addEventListener('beforeunload',function(e){ if(DIRTY){ e.preventDefault(); e.returnValue=''; } });
document.getElementById('ov').onclick=function(e){ if(e.target===this) closeM(); };
document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeM(); });
// One tab per resolution; badge = that resolution's WORST content completeness
// (min across pages), coloured, so a weak breakpoint is obvious at a glance.
function renderTabs(){
  var el=document.getElementById('tabs'); if(!el)return;
  if(!RES||!RES.length){ el.innerHTML=''; return; }
  el.innerHTML='';
  RES.forEach(function(res){
    var worst=null;
    ROWS.forEach(function(r){ var c=r.bp&&r.bp[res.name]&&r.bp[res.name].content; if(c!=null) worst=(worst==null)?c:Math.min(worst,c); });
    var badge=worst==null?'':' <span class="badge '+clsHi(worst)+'">'+worst+'%</span>';
    var b=document.createElement('div'); b.className='tab'+(res.name===activeRes?' active':'');
    b.innerHTML='<span class="rlabel">'+esc(res.label)+'</span>'+badge;
    b.onclick=function(){ activeRes=res.name; renderTabs(); render();
      if(document.getElementById('ov').style.display==='block'&&LASTOPENED!=null) openM(LASTOPENED); };
    el.appendChild(b);
  });
}
renderTabs();
render();
</script></body></html>`;

  const p = path.join(outDir, 'CUSTOMER-Report.html');
  fs.writeFileSync(p, html);
  return p;
}

module.exports = { writeCustomerReport };
