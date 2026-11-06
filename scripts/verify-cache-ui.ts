/**
 * Why this file exists: it proves the semantic cache page works in a real browser. A person
 * runs it with the server up. It opens the page in headless Chrome with a throwaway profile
 * and runs checks inside the page for three cases: a miss, a hit and a degraded hit at a low
 * threshold. Without it, a broken page would still pass the server tests.
 * It uses no remote debugging protocol and no existing browser profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

/** The project folder. Run this script from there. */
const root = process.cwd();

/** A copy of the page with the test script added. Deleted when the run ends. */
const harness = path.join(root, 'public/__cache-verification.html');

const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

/** Script added to the top of the page. Collects script errors and the timers the page starts. */
const capture = `<script>
window.__errors=[];window.__intervals=[];const interval=window.setInterval;window.setInterval=(...args)=>{const id=interval(...args);window.__intervals.push(id);return id;};
window.addEventListener('error',e=>window.__errors.push(e.message||'resource load error'),true);
window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
const originalError=console.error;console.error=(...args)=>{window.__errors.push(args.map(String).join(' '));originalError(...args);};
</script>`;

/**
 * The checks, added to the end of the page, run in Chrome.
 * Prints VERIFY PASSED or VERIFY FAILED, which this script waits for.
 * The mode in the page address picks the case: miss, hit or degraded.
 */
const checks = `<script type="module">
const mode=new URL(location.href).searchParams.get('mode');
const wait=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,40));}throw new Error('UI condition timed out: '+fn);};
const verdict=()=>document.querySelector('#cache-verdict').textContent;
const run=async(label)=>{
 const buttons=[...document.querySelectorAll('#presets button')];
 buttons.find(b=>b.textContent===label).click();
 await wait(()=>!document.querySelector('#btn-run').disabled && /CACHE (HIT|MISS)|LOW-THRESHOLD HIT/.test(verdict()));
};
try{
 await wait(()=>document.querySelectorAll('#presets button').length===4 && document.querySelector('#badge-mode').textContent!=='…');
 await fetch('/api/cache/clear',{method:'POST'});
 const slider=document.querySelector('#cache-threshold');
 slider.value='0.85';slider.dispatchEvent(new Event('input',{bubbles:true}));
 console.log('VERIFY running payment');await run('Payment declined');console.log('VERIFY payment complete');
 if(!verdict().includes('CACHE MISS'))throw new Error('Expected miss');
 await wait(()=>document.querySelectorAll('.cache-pair').length===1);
 if(mode!=='miss'){
   await run('Payment declined (paraphrase)');
   if(!verdict().includes('CACHE HIT'))throw new Error('Expected paraphrase hit');
   if(!document.querySelector('#stage-card').textContent.includes('Served from Semantic Cache'))throw new Error('Missing answer shortcut banner');
   if(mode==='degraded'){
     slider.value='0.50';slider.dispatchEvent(new Event('input',{bubbles:true}));
     await run('14-day refund policy');
     if(!verdict().includes('LOW-THRESHOLD HIT'))throw new Error('Expected degradation hit');
     if(!document.querySelector('#stage-card').textContent.includes('Quality Degradation Notice'))throw new Error('Missing degradation notice');
   }
 }
 document.querySelector('#btn-bm25-math').click();
 await wait(()=>document.querySelector('#bm25-modal').open);
 if(!document.querySelector('#bm25-modal').open)throw new Error('BM25 lab failed');
 document.querySelector('#bm25-modal').close();
 document.querySelector('#btn-cosine-lab').click();
 await wait(()=>document.querySelector('#cosine-canvas-host canvas'));
 if(!document.querySelector('#cosine-canvas-host canvas'))throw new Error('Cosine lab failed');
 document.querySelector('#cosine-modal').close();
 if(document.querySelectorAll('.stage-node').length!==5)throw new Error('Lost five-stage rail');
 if(!document.querySelector('#pipeline-canvas-host canvas'))throw new Error('3D canvas failed');
 const result=document.createElement('div');result.id='cache-verification-result';result.hidden=true;
 result.dataset.status=window.__errors.length?'failed':'passed';result.dataset.errors=JSON.stringify(window.__errors);
 result.dataset.verdict=verdict();document.body.append(result);console.log('VERIFY PASSED',mode,JSON.stringify(window.__errors));
 // Test teardown: stop perpetual polling/animation after asserting live updates.
 window.__intervals.forEach(clearInterval);window.requestAnimationFrame=()=>0;
}catch(e){const result=document.createElement('div');result.id='cache-verification-result';result.dataset.status='failed';result.textContent=String(e);document.body.append(result);console.log('VERIFY FAILED',String(e));}
window.__intervals.forEach(clearInterval);window.requestAnimationFrame=()=>0;
</script>`;

fs.writeFileSync(
  harness,
  html.replace('<head>', '<head>' + capture).replace('</body>', checks + '</body>'),
);

try {
  for (const mode of ['miss', 'hit', 'degraded']) {
    /** A throwaway Chrome profile for this case. */
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-chrome-'));
    const screenshot = `/workspace/semantic-cache-${mode}.png`;
    /**
     * Runs Chrome and collects its output.
     * Stops Chrome when it finishes, or after the time limit.
     */
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn('google-chrome', [
          '--headless=new',
          '--disable-extensions',
          '--disable-background-networking',
          '--enable-logging=stderr',
          '--no-sandbox',
          '--enable-unsafe-swiftshader',
          '--disable-dev-shm-usage',
          `--user-data-dir=${profile}`,
          '--window-size=1480,920',
          '--force-device-scale-factor=1',
          '--timeout=10000',
          `--screenshot=${screenshot}`,
          '--dump-dom',
          `http://127.0.0.1:3098/__cache-verification.html?mode=${mode}`,
        ]);
        let stdout = '',
          stderr = '',
          settling = false;
        const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => {
          stderr += d;
          /**
           * Chrome's screenshot mode can hang after every check has passed, because the
           * page keeps drawing 3D forever. Once our line appears, stop Chrome after 1.5
           * seconds. The log is kept as proof. If Chrome hangs, the screenshot is missing
           * and the script says so.
           */
          if (
            !settling &&
            (stderr.includes(`VERIFY PASSED ${mode}`) || stderr.includes('VERIFY FAILED'))
          ) {
            settling = true;
            setTimeout(() => child.kill('SIGTERM'), 1500);
          }
        });
        child.on('exit', (status) => {
          clearTimeout(timeout);
          resolve({ status, stdout, stderr });
        });
      },
    );
    fs.writeFileSync(`/workspace/semantic-cache-${mode}.dom.html`, result.stdout);
    fs.writeFileSync(`/workspace/semantic-cache-${mode}.chrome.log`, result.stderr);
    try {
      assert.ok(result.stderr.includes(`VERIFY PASSED ${mode} []`), result.stderr);
      console.log(`${mode}: browser assertions passed; zero JS console/page errors`);
      console.log(
        fs.existsSync(screenshot)
          ? `Screenshot: ${screenshot}`
          : 'WARNING: native Chrome screenshot command hung; screenshot not saved.',
      );
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(harness, { force: true });
}
