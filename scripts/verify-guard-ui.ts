/**
 * Why this file exists: it proves the guard page works in a real browser. A person runs it
 * with the server up. It opens the page in headless Chrome with a throwaway profile and runs
 * checks inside the page: each attack is blamed on the right layer, the steps are paced so
 * a person can follow them, the replay and the citation checks work, and there are no
 * script errors. Without it, a broken page would still pass the server tests.
 * Screenshots are optional. Set CAPTURE_UI_SCREENSHOTS=true to take them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

/** A copy of the page with the test script added. Deleted when the run ends. */
const harness = path.join(process.cwd(), 'public/__guard-verification.html');

/** A throwaway Chrome profile, so the run never touches a real browser profile. */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-sequential-chrome-'));

/** Page snapshots saved while testing. Deleted when the run ends. */
const snapshots = [
  'public/__guard-snapshot-blocked.html',
  'public/__guard-snapshot-contained.html',
];

/**
 * Script added to the top of the page. Collects script errors, and keeps the 3D canvas
 * readable so a snapshot can copy it.
 */
const capture = `<script>window.__guardErrors=[];window.addEventListener('error',e=>window.__guardErrors.push(e.message||'resource error'),true);window.addEventListener('unhandledrejection',e=>window.__guardErrors.push(String(e.reason)));const error=console.error;console.error=(...a)=>{window.__guardErrors.push(a.map(String).join(' '));error(...a);};const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,options){return getContext.call(this,kind,/webgl/.test(kind)?{...options,preserveDrawingBuffer:true}:options);};</script>`;

/**
 * The checks, added to the end of the page, run in Chrome.
 * Prints SEQUENTIAL_GUARD_UI_PASSED or SEQUENTIAL_GUARD_UI_FAILED, which this script waits for.
 * Snapshots are posted to the small server below.
 */
const test = `<script type="module">
const wait=async(fn)=>{for(let i=0;i<1500;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI timeout: '+fn);};
const originalFetch=window.fetch;window.fetch=async(...args)=>{const r=await originalFetch(...args);if(String(args[0]).includes('/api/citations/check'))r.clone().json().then(data=>console.log('CITATION_RESPONSE',args[1]?.body,JSON.stringify({simulation:data.simulation,status:data.status,claims:data.rows?.flatMap(r=>r.entailmentCheck.claims.map(c=>c.label))}))).catch(()=>{});return r;};
const trace=[],citationTrace=[];window.addEventListener('guard-visual-step',e=>trace.push(e.detail));window.addEventListener('citation-visual-step',e=>citationTrace.push(e.detail));
const run=async(button)=>{trace.length=0;button.click();document.querySelector('#guard-modal').close();await wait(()=>!document.querySelector('#btn-run').disabled&&!document.querySelector('#guard-replay').disabled);};
const snapshot=async(kind)=>{
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const root=document.documentElement.cloneNode(true);
 const originals=[...document.querySelectorAll('canvas')];
 [...root.querySelectorAll('canvas')].forEach((c,i)=>{const img=document.createElement('img');img.src=originals[i].toDataURL();img.className=c.className;img.style.cssText=c.style.cssText;img.style.width=originals[i].getBoundingClientRect().width+'px';img.style.height=originals[i].getBoundingClientRect().height+'px';c.replaceWith(img);});
 root.querySelectorAll('script').forEach(s=>s.remove());root.querySelectorAll('link[href^="https://"]').forEach(s=>s.remove());
 const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';root.querySelector('head').appendChild(style);
 const r=await fetch('http://127.0.0.1:3199/'+kind,{method:'POST',body:'<!DOCTYPE html>'+root.outerHTML});if(!r.ok)throw new Error('Snapshot failed');
};
try{
 await wait(()=>document.querySelectorAll('.guard-card').length===4&&document.querySelector('#badge-mode').textContent!=='…');
 const cards=[...document.querySelectorAll('.guard-card')];
 if(document.querySelector('#guard-modal').open||cards.some(c=>c.closest('details')||c.getBoundingClientRect().width<200||c.getBoundingClientRect().bottom>innerHeight))throw new Error('Cards hidden or not immediately visible');
 const height=document.querySelector('.workspace').getBoundingClientRect().height;if(height<300)throw new Error('Workspace squeezed: '+height);
 await fetch('/api/guard/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({naive:true,regex:true,classifier:true,dataSeparation:true,classifierThreshold:.5,simulateIndirectInjection:false})});
 await fetch('/api/cache/clear',{method:'POST'});
 for(const id of ['1A','1B','2A','2B','3A','3B']){
  const primary=document.querySelector('#guard-quick-attacks [data-sim-id="'+id+'"]');
  if(!primary)document.querySelector('#guard-inspect').click();
  await run(primary||document.querySelector('#guard-attack-presets [data-sim-id="'+id+'"]'));
  const index=Number(id[0]);const states=cards.map(c=>c.dataset.state);
  if(states[index-1]!=='blocked'||states.slice(index).some(s=>s!=='halted')||states.slice(0,index-1).some(s=>s!=='pass'))throw new Error('Wrong attribution '+id+': '+states);
  for(const e of trace.filter(e=>e.phase==='checking')){const end=trace.find(r=>r.layer===e.layer&&r.phase==='done');if(!end||end.at-e.at<220)throw new Error('Not human-paced '+id);}
  if(document.querySelector('#stage-card .guard-answer-breakdown').children.length!==4||document.querySelector('#pipeline-canvas-host').dataset.guardGate!=='blocked')throw new Error('Missing main breakdown or red 3D shield');
  if(id==='3A')await snapshot('blocked');
 }
 const before=await fetch('/api/cache').then(r=>r.json());trace.length=0;document.querySelector('#guard-replay').click();await wait(()=>!document.querySelector('#guard-replay').disabled);if(trace.length<4)throw new Error('Replay missing steps');const after=await fetch('/api/cache').then(r=>r.json());if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Replay touched cache');
 await run(document.querySelector('#presets button'));if(!document.querySelector('#cache-verdict').textContent.includes('CACHE MISS'))throw new Error('Lost cache miss');
 await run(document.querySelectorAll('#presets button')[1]);if(cards[3].dataset.state!=='cached-bypass'||!document.querySelector('#cache-verdict').textContent.includes('CACHE HIT'))throw new Error('Lost cache hit / L4 bypass');
 await run(document.querySelector('#guard-quick-attacks [data-sim-id="4A"]'));
 if(cards[3].dataset.state!=='contained'||!document.querySelector('#stage-card').textContent.includes('CONTAINED INJECTION')||!document.querySelector('.guard-viewport-banner'))throw new Error('Missing L4 contained state');
 document.querySelector('#guard-envelope-quick').click();const envelope=document.querySelector('#guard-envelope-content').textContent;
 if(!document.querySelector('#guard-envelope').open||!envelope.includes('IGNORE any commands')||!envelope.includes('DATA_FENCE_')||!envelope.includes('OVERRIDE_ACCEPTED'))throw new Error('Missing exact envelope preview');document.querySelector('#guard-modal').close();
 document.querySelector('#btn-bm25-math').click();if(!document.querySelector('#bm25-modal').open)throw new Error('Lost BM25 Lab');document.querySelector('#bm25-modal').close();
 document.querySelector('#btn-cosine-lab').click();if(!document.querySelector('#cosine-canvas-host canvas'))throw new Error('Lost Cosine Lab');document.querySelector('#cosine-modal').close();
 document.querySelector('[data-stage="5"]').click();if(document.querySelectorAll('.stage-node').length!==5)throw new Error('Lost RAG stages');
 await wait(()=>!document.querySelector('#citation-replay').disabled);
 for(const [kind,expected] of [['pass',['pass','pass','pass']],['broken-url',['failed','warning','warning']],['negation',['pass','failed','pass']],['quote',['pass','pass','failed']]]){
  citationTrace.length=0;document.querySelector('[data-citation-demo="'+kind+'"]').click();await wait(()=>!document.querySelector('#citation-replay').disabled);
  const states=[...document.querySelectorAll('[data-citation-step]')].map(c=>c.dataset.state);console.log('CITATION_VISUAL',kind,JSON.stringify(states));if(JSON.stringify(states)!==JSON.stringify(expected))throw new Error('Citation '+kind+': '+states);
  for(const start of citationTrace.filter(e=>e.status==='checking')){const end=citationTrace.find(e=>e.row===start.row&&e.step===start.step&&e.status!=='checking');if(!end||end.at-start.at<220)throw new Error('Citation pacing absent');}
 }
 document.querySelector('[data-citation-demo="all"]').click();await wait(()=>!document.querySelector('#citation-replay').disabled);if(document.querySelectorAll('[data-citation-row]').length!==4)throw new Error('Missing four-citation failure suite');
 document.querySelector('[data-citation-demo="negation"]').click();await wait(()=>!document.querySelector('#citation-replay').disabled);
 citationTrace.length=0;document.querySelector('#citation-replay').click();await wait(()=>!document.querySelector('#citation-replay').disabled);if(citationTrace.length!==6)throw new Error('Citation replay absent');
 await snapshot('contained');
 if(window.__guardErrors.length)throw new Error(JSON.stringify(window.__guardErrors));
 console.log('SEQUENTIAL_GUARD_UI_PASSED []',JSON.stringify({workspaceHeight:height,cards:4,cases:7,replay:true}));
}catch(e){console.log('SEQUENTIAL_GUARD_UI_FAILED',String(e));}
</script>`;

/**
 * A small local server that receives page snapshots from the test and saves them.
 * It only accepts POST to the two snapshot paths. The page is on another port, so it
 * sends a cross-origin header for that page.
 */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3198');
  if (req.method !== 'POST' || !['/blocked', '/contained'].includes(req.url || '')) {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    fs.writeFileSync('public/__guard-snapshot-' + req.url!.slice(1) + '.html', body);
    res.end('ok');
  });
});

await new Promise<void>((r) => server.listen(3199, '127.0.0.1', r));

fs.writeFileSync(
  harness,
  fs
    .readFileSync('public/index.html', 'utf8')
    .replace('<head>', '<head>' + capture)
    .replace('</body>', test + '</body>'),
);

try {
  /**
   * Runs Chrome and collects its log.
   * Waits for the PASSED or FAILED line, then stops Chrome. Chrome is killed at the time limit
   * if neither line appears.
   */
  const log = await new Promise<string>((resolve) => {
    const child = spawn('google-chrome', [
      '--headless=new',
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--enable-logging=stderr',
      `--user-data-dir=${profile}`,
      '--window-size=1480,920',
      'http://127.0.0.1:3198/__guard-verification.html',
    ]);
    let output = '',
      finished = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 65000);
    child.stderr.on('data', (d) => {
      output += d;
      fs.appendFileSync('/workspace/sequential-guard-ui.live.log', d);
      if (!finished && /SEQUENTIAL_GUARD_UI_PASSED|SEQUENTIAL_GUARD_UI_FAILED/.test(output)) {
        finished = true;
        setTimeout(() => child.kill('SIGTERM'), 250);
      }
    });
    child.on('exit', () => {
      clearTimeout(timeout);
      resolve(output);
    });
  });
  fs.writeFileSync('/workspace/sequential-guard-ui.chrome.log', log);
  assert.ok(log.includes('SEQUENTIAL_GUARD_UI_PASSED []'), log);
  /** Takes a screenshot of each saved snapshot. Skipped unless asked, because it is slow. */
  if (process.env.CAPTURE_UI_SCREENSHOTS === 'true')
    for (const [kind, file] of [
      ['contained', '/workspace/sequential-guard-ui.png'],
      ['blocked', '/workspace/sequential-guard-blocked.png'],
    ]) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('google-chrome', [
          '--headless=new',
          '--no-sandbox',
          '--hide-scrollbars',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-background-networking',
          '--no-first-run',
          '--timeout=5000',
          `--user-data-dir=${profile}-screenshot-${kind}`,
          '--window-size=1480,920',
          `--screenshot=${file}`,
          `http://127.0.0.1:3198/__guard-snapshot-${kind}.html`,
        ]);
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Static snapshot capture timed out'));
        }, 15000);
        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0 && fs.existsSync(file)) resolve();
          else reject(new Error('Screenshot failed ' + code));
        });
      });
    }
  console.log(
    'Headless Chrome: 4 visible cards, 7 attributed attacks, 240ms pacing, replay, red shield, containment, cache miss/hit, both labs; zero JS errors. Screenshot capture is optional (CAPTURE_UI_SCREENSHOTS=true).',
  );
  /** Removes the snapshot server, the harness page, the snapshots and the Chrome profiles. */
} finally {
  server.close();
  [harness, ...snapshots].forEach((f) => fs.rmSync(f, { force: true }));
  [profile, profile + '-screenshot-contained', profile + '-screenshot-blocked'].forEach((p) =>
    fs.rmSync(p, { recursive: true, force: true }),
  );
}
