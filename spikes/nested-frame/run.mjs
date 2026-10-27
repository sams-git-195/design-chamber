// Spike: can a sandboxed, CSP-bound OpenChamber guest render a design in a
// nested blob:/srcdoc/data: iframe, with the design's own inline script and
// blob-URL images/CSS working? Reproduces the host's frame setup:
//   top.html (the app)  ->  <iframe sandbox="allow-scripts" src="/guest.html">
//   guest.html is served with guestFramePolicy(...) + "sandbox allow-scripts",
//   copied from openchamber/packages/sdk/src/frame-policy.ts.
// Then runs headless Chrome with --dump-dom and prints the results JSON.
//
// Usage: node spikes/nested-frame/run.mjs [chromePath]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const guestFramePolicy = (connectSource, origins = []) => {
  const approved = origins.length > 0 ? ` ${origins.join(' ')}` : '';
  const local = "'self' data: blob:";
  const connect = [connectSource, ...origins].filter(Boolean);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${local}`,
    `style-src 'unsafe-inline' ${local}${approved}`,
    `img-src ${local}${approved}`,
    `font-src ${local}${approved}`,
    `media-src ${local}${approved}`,
    `worker-src ${local}`,
    `frame-src ${local}`,
    `connect-src ${connect.length > 0 ? connect.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
};

const TOP = `<!doctype html><html><body><pre id="out">pending</pre>
<iframe sandbox="allow-scripts" src="/guest/guest.html" width="400" height="300"></iframe>
<img src="/slow" alt="">
<script>
addEventListener('message', (e) => { if (e.data && e.data.spike) document.getElementById('out').textContent = JSON.stringify(e.data.results); });
</script></body></html>`;

// The "design" document: inline script, blob image, blob CSS background, eval,
// fetch of a blob URL (connect-src has no blob:), relative image (no base).
const DESIGN = (label) => `<!doctype html><html><head><style>#bg{width:4px;height:4px;background:url(__CSSURL__)}</style></head><body>
<img id="i" src="__IMGURL__"><img id="rel" src="assets/x.png"><div id="bg"></div>
<script>
(async () => {
  const r = { label: ${JSON.stringify(label)}, inlineScript: true, origin: String(self.origin), violations: [] };
  document.addEventListener('securitypolicyviolation', (e) => r.violations.push(e.violatedDirective + ' ' + String(e.blockedURI).slice(0, 12)));
  try { r.evalOk = eval('1+1') === 2; } catch (e) { r.evalOk = 'blocked'; }
  const img = document.getElementById('i');
  r.blobImg = await new Promise((ok) => { if (img.complete) ok(img.naturalWidth > 0); img.onload = () => ok(true); img.onerror = () => ok(false); });
  const rel = document.getElementById('rel');
  r.relativeImg = await new Promise((ok) => { if (rel.complete) ok(rel.naturalWidth > 0); rel.onload = () => ok(true); rel.onerror = () => ok(false); });
  try { const res = await fetch('__IMGURL__'); r.fetchBlob = res.ok; } catch (e) { r.fetchBlob = 'blocked'; }
  const load = (src) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(true); im.onerror = () => ok(false); im.src = src; });
  r.dataImg = await load('data:image/png;base64,__PNG__');
  const own = Uint8Array.from(atob('__PNG__'), (c) => c.charCodeAt(0));
  r.ownBlobImg = await load(URL.createObjectURL(new Blob([own], { type: 'image/png' })));
  r.cssBg = getComputedStyle(document.getElementById('bg')).backgroundImage.startsWith('url(');
  r.reachTop = (() => { try { return Boolean(parent.parent.document); } catch { return 'denied'; } })();
  r.fetchExternal = await Promise.race([fetch('https://example.com/').then(() => true, () => 'blocked'), new Promise((ok) => setTimeout(() => ok('hang'), 500))]);
  await new Promise((ok) => setTimeout(ok, 50));
  parent.postMessage({ design: r }, '*');
})();
</script></body></html>`;

const GUEST = `<!doctype html><html><body><script>
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const bytes = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));
const imgUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
const tpl = ${JSON.stringify(DESIGN('X')).replaceAll('</', '<\\/')};
const doc = (label) => tpl.replace('"X"', JSON.stringify(label)).replaceAll('__IMGURL__', imgUrl).replaceAll('__CSSURL__', imgUrl).replaceAll('__PNG__', PNG);
const results = { guestOrigin: String(self.origin) };
results.guestBlobImg = null;
{ const im = new Image(); im.onload = () => { results.guestBlobImg = true; }; im.onerror = () => { results.guestBlobImg = false; }; im.src = imgUrl; }
const frames = [];
const mk = (label, set) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); set(f); document.body.appendChild(f); frames.push([label, f]); };
mk('blob', (f) => { f.src = URL.createObjectURL(new Blob([doc('blob')], { type: 'text/html' })); });
mk('srcdoc', (f) => { f.srcdoc = doc('srcdoc'); });
mk('data', (f) => { f.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(doc('data')); });
addEventListener('message', (e) => {
  const hit = frames.find(([, f]) => f.contentWindow === e.source);
  if (!hit || !e.data || !e.data.design) return;
  results[hit[0]] = e.data.design;
  if (frames.every(([l]) => results[l])) parent.postMessage({ spike: true, results }, '*');
});
setTimeout(() => parent.postMessage({ spike: true, results: { ...results, timeout: true } }, '*'), 4000);
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/top.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(TOP);
  }
  if (req.url === '/guest/guest.html') {
    const { port } = server.address();
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': `${guestFramePolicy(`http://127.0.0.1:${port}/guest/`)}; sandbox allow-scripts`,
    });
    return res.end(GUEST);
  }
  // Holds the top page's load event (when --dump-dom fires) until frames report.
  if (req.url === '/slow') return setTimeout(() => { res.writeHead(404); res.end(); }, 3500);
  res.writeHead(404);
  res.end();
});

const chromeCandidates = [
  process.argv[2],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = chromeCandidates.find((p) => existsSync(p)) ?? 'google-chrome';

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--timeout=7000',
    `--user-data-dir=${process.env.TEMP ?? '/tmp'}/dc-spike-${Date.now()}`,
    '--dump-dom', `http://127.0.0.1:${port}/top.html`,
  ]);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('exit', () => {
    const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    console.log(m ? m[1].replaceAll('&quot;', '"') : out.slice(0, 2000));
    server.close();
  });
});
