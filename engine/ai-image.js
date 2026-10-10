// AI image engine — Higgsfield CLI wrapper (their "AI Silly Pics" / generative tools family).
// GATED: needs `higgsfield auth login` (user-interactive, never done by automation).
// Setup:   node engine/ai-image.js --check          → validates auth → picks/verifies a model → writes logs/.ai-image-ready + ai-image.json
// Use:     node engine/ai-image.js --generate --prompt "…" --out C:\path\out.png [--image C:\in.png]
// Degrades gracefully: callers treat a missing .ready marker as "feature off", never as an error.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const READY = path.join(ROOT, 'logs', '.ai-image-ready');
const CONF = path.join(ROOT, 'ai-image.json');
function arg(name, fb) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fb; }

function hf(args, { timeout = 120000 } = {}) {
  const r = spawnSync('cmd.exe', ['/c', 'higgsfield', ...args], { encoding: 'utf8', timeout });
  return { code: r.status, out: (r.stdout || '') + '', err: (r.stderr || '') + '' };
}
const tryJSON = (s) => { try { const a = s.indexOf('['), o = s.indexOf('{'); const i = a >= 0 && (o < 0 || a < o) ? a : o; return JSON.parse(s.slice(i)); } catch { return null; } };

function isReady() { return fs.existsSync(READY) && fs.existsSync(CONF); }

async function check() {
  const list = hf(['model', 'list', '--json']);
  if (/session expired|auth login/i.test(list.out + list.err) || list.code !== 0) {
    try { fs.rmSync(READY); } catch {}
    console.log('NOT READY: Higgsfield session expired or not logged in.');
    console.log('Fix (you, 2 min): run `higgsfield auth login` in any terminal, then re-run this check.');
    console.log('RESULT:' + JSON.stringify({ ready: false, reason: 'auth' }));
    process.exitCode = 1; return;
  }
  const models = tryJSON(list.out) || [];
  const flat = Array.isArray(models) ? models : (models.models || models.data || []);
  const names = flat.map((m) => m.id || m.name || m.model || '').filter(Boolean);
  console.log('models visible: ' + (names.slice(0, 12).join(', ') || '(unparsed — raw list ok)'));
  // prefer an image-edit-capable model (their GPT Image family), else first image model
  const preferred = names.find((n) => /gpt.?image/i.test(n)) || names.find((n) => /image|photo|flux|seedream/i.test(n)) || names[0] || '';
  if (!preferred) {
    console.log('NOT READY: could not identify an image model from `model list` — run `higgsfield model list` manually and put the id in ai-image.json as {"model":"<id>"}.');
    console.log('RESULT:' + JSON.stringify({ ready: false, reason: 'no-model' }));
    process.exitCode = 1; return;
  }
  const params = hf(['model', 'get', preferred]);
  console.log('model params (`model get ' + preferred + '`):\n' + (params.out || params.err).slice(0, 1500));
  fs.writeFileSync(CONF, JSON.stringify({ model: preferred, checked: new Date().toISOString() }, null, 2));
  fs.mkdirSync(path.dirname(READY), { recursive: true });
  fs.writeFileSync(READY, new Date().toISOString());
  console.log('READY with model: ' + preferred);
  console.log('RESULT:' + JSON.stringify({ ready: true, model: preferred }));
}

async function generate() {
  if (!isReady()) throw new Error('ai-image not set up — run: node engine/ai-image.js --check (after `higgsfield auth login`)');
  const { model } = JSON.parse(fs.readFileSync(CONF, 'utf8'));
  const prompt = arg('--prompt', process.env.SOMEME_PROMPT || '');
  const out = arg('--out', '');
  const image = arg('--image', '');
  if (!prompt || !out) throw new Error('--prompt and --out required');

  let imageId = null;
  if (image) {
    const up = hf(['upload', image, '--json'], { timeout: 300000 });
    const uj = tryJSON(up.out);
    imageId = uj && (uj.id || uj.upload_id || (uj.data && uj.data.id));
    if (!imageId) throw new Error('upload failed: ' + (up.err || up.out).slice(-300));
    console.log('uploaded input image: ' + imageId);
  }
  const createArgs = ['generate', 'create', model, '--prompt', prompt, '--json'];
  if (imageId) createArgs.push('--image', imageId);
  const cr = hf(createArgs, { timeout: 300000 });
  const cj = tryJSON(cr.out);
  const jobId = cj && (cj.id || cj.job_id || (cj.data && cj.data.id));
  if (!jobId) throw new Error('generate create failed: ' + (cr.err || cr.out).slice(-400));
  console.log('job: ' + jobId + ' (waiting)');
  const w = hf(['generate', 'wait', jobId, '--json'], { timeout: 600000 });
  const wj = tryJSON(w.out) || {};
  const urls = JSON.stringify(wj).match(/https?:\/\/[^"\\]+\.(?:png|jpg|jpeg|webp)[^"\\]*/gi) || [];
  if (!urls.length) throw new Error('no output asset in wait result: ' + (w.err || w.out).slice(-400));
  const r = await fetch(urls[0]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('saved ' + out);
  console.log('RESULT:' + JSON.stringify({ file: out, source_url: urls[0].slice(0, 120) }));
}

if (require.main === module) {
  (process.argv.includes('--check') ? check() : generate()).catch((e) => { console.error('AI-IMAGE ERROR: ' + (e.message || e)); process.exitCode = 1; });
}
module.exports = { isReady };
