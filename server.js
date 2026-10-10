// SoMeme — local meme marketing OS (Memelord.com functional rebuild, original code)
// Port 8797 · loopback only · workspaces are folders · engines are spawnable scripts
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 8797;
const WS_DIR = path.join(ROOT, 'workspaces');
const TPL_DIR = path.join(ROOT, 'templates');
const LOG_DIR = path.join(ROOT, 'logs');

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use('/app', express.static(path.join(ROOT, 'public')));
app.use('/templates/images', express.static(path.join(TPL_DIR, 'images')));
app.use('/templates/videos', express.static(path.join(TPL_DIR, 'videos')));
app.use('/templates/harvest', express.static(path.join(TPL_DIR, 'harvest'))); // harvested Memelord media
app.get('/', (_q, s) => s.redirect('/app/index.html'));

// ---------- helpers ----------
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const wsPath = (ws) => path.join(WS_DIR, ws.replace(/[^a-z0-9_-]/gi, '_'));
const ensureWs = (ws) => {
  const d = wsPath(ws);
  for (const sub of ['drops', 'exports', 'assets']) fs.mkdirSync(path.join(d, sub), { recursive: true });
  const prof = path.join(d, 'profile.json');
  if (!fs.existsSync(prof)) writeJSON(prof, { name: ws, voice: '', topics: [], banned_topics: [], nsfw: false, created: new Date().toISOString() });
  return d;
};
const log = (line) => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, 'server.log'), `[${new Date().toISOString()}] ${line}\n`);
};

// ---------- background jobs (spawn rule: ignore/pipe/pipe + drain BOTH) ----------
const jobs = {}; // id -> {status, engine, args, out, err, result, started, ended}
// Each meme-gen job spawns node + a claude CLI; 6 at once blew this PC's fixed commit limit
// ("Fatal JavaScript out of memory", claude exit 0xC0000409). Extra jobs wait here; status stays
// 'running' (with queued:true) so MCP/UI pollers keep waiting instead of reading it as finished.
const GEN_LIMIT = parseInt(process.env.SOMEME_GEN_CONCURRENCY || '2', 10);
const genWaiting = [];
let genActive = 0;
function runJob(engine, args, extraEnv = {}) {
  const id = 'job-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const job = { id, status: 'running', engine, args, out: '', err: '', result: null, started: Date.now(), ended: null };
  jobs[id] = job;
  if (engine !== 'meme-gen.js') { startJob(job, extraEnv); return job; }
  job.queued = true;
  genWaiting.push(() => startJob(job, extraEnv, () => { genActive--; pumpGen(); }));
  pumpGen();
  return job;
}
function pumpGen() {
  while (genActive < GEN_LIMIT && genWaiting.length) { genActive++; genWaiting.shift()(); }
}
function startJob(job, extraEnv, onDone = () => {}) {
  const { id, engine, args } = job;
  job.queued = false;
  let finished = false;
  const finish = () => { if (!finished) { finished = true; onDone(); } };
  const child = spawn(process.execPath, [path.join(ROOT, 'engine', engine), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { job.out += d; if (job.out.length > 2e6) job.out = job.out.slice(-1e6); });
  child.stderr.on('data', (d) => { job.err += d; if (job.err.length > 2e6) job.err = job.err.slice(-1e6); });
  child.on('close', (code) => {
    job.ended = Date.now();
    // engine contract: last line starting with RESULT: carries JSON
    const m = job.out.split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
    if (m) { try { job.result = JSON.parse(m.slice(7)); } catch { /* keep raw */ } }
    job.status = code === 0 ? 'done' : 'failed';
    log(`job ${id} (${engine}) ${job.status}${code ? ' code=' + code : ''}`);
    finish();
  });
  child.on('error', (e) => { job.status = 'failed'; job.err += String(e); job.ended = Date.now(); finish(); });
}

// ---------- state ----------
app.get('/api/health', (_q, s) => s.json({ ok: true, app: 'SoMeme', port: PORT }));
app.get('/api/state', (req, res) => {
  const ws = req.query.ws || 'default';
  const d = ensureWs(ws);
  const workspaces = fs.readdirSync(WS_DIR).filter((f) => fs.statSync(path.join(WS_DIR, f)).isDirectory());
  const drops = readJSON(path.join(d, 'drops.json'), []);
  const missions = readJSON(path.join(d, 'missions.json'), []);
  const trending = readJSON(path.join(TPL_DIR, 'trending.json'), { updated: null, items: [] });
  const index = readJSON(path.join(TPL_DIR, 'index.json'), { templates: [] });
  res.json({
    ws, workspaces,
    profile: readJSON(path.join(d, 'profile.json'), {}),
    counts: { templates: index.templates.length, drops: drops.filter((x) => x.status === 'new').length, missions: missions.length },
    trending_updated: trending.updated,
  });
});

// ---------- templates ----------
app.get('/api/templates', (req, res) => {
  const { q = '', tag = '', type = 'image', tab = 'classics' } = req.query;
  const index = readJSON(path.join(TPL_DIR, 'index.json'), { templates: [] });
  let items = index.templates.filter((t) => (t.type || 'image') === type);
  if (tab === 'trending') {
    const tr = readJSON(path.join(TPL_DIR, 'trending.json'), { items: [] });
    return res.json({ items: tr.items, updated: tr.updated || null });
  }
  if (tab === 'liked') {
    const liked = readJSON(path.join(TPL_DIR, 'liked.json'), []);
    items = items.filter((t) => liked.includes(t.id));
  }
  if (q) { const n = q.toLowerCase(); items = items.filter((t) => (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().includes(n)); }
  if (tag) items = items.filter((t) => (t.tags || []).includes(tag));
  res.json({ items: items.slice(0, 200), total: items.length });
});
app.post('/api/templates/import', (req, res) => {
  // {name, image_base64?|url?, description?, tags?} — importer also runnable standalone
  const job = runJob('import-template.js', ['--json'], { SOMEME_IMPORT: JSON.stringify(req.body || {}) });
  res.json({ job_id: job.id });
});
app.post('/api/templates/:id/layout', (req, res) => {
  // composer saves per-template box layout back to the index
  const index = readJSON(path.join(TPL_DIR, 'index.json'), { templates: [] });
  const t = index.templates.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'template not found' });
  t.boxes = req.body.boxes || t.boxes;
  writeJSON(path.join(TPL_DIR, 'index.json'), index);
  res.json({ ok: true });
});

// ---------- generation (chat) ----------
app.post('/api/generate', (req, res) => {
  const { ws = 'default', prompt = '', count = 1, template_id = '', style = '', history = [] } = req.body || {};
  if (!prompt.trim() && !template_id) return res.status(400).json({ error: 'prompt or template_id required' });
  ensureWs(ws);
  const job = runJob('meme-gen.js', ['--ws', ws, '--count', String(Math.min(4, count || 1))],
    { SOMEME_PROMPT: prompt, SOMEME_TEMPLATE: template_id, SOMEME_STYLE: style, SOMEME_HISTORY: JSON.stringify(history.slice(-6)) });
  res.json({ job_id: job.id });
});
app.post('/api/edit', (req, res) => {
  const { ws = 'default', instruction = '', artifact = null } = req.body || {};
  if (!instruction.trim() || !artifact) return res.status(400).json({ error: 'instruction and artifact required' });
  const job = runJob('meme-gen.js', ['--ws', ws, '--edit'],
    { SOMEME_PROMPT: instruction, SOMEME_ARTIFACT: JSON.stringify(artifact) });
  res.json({ job_id: job.id });
});
app.post('/api/render', async (req, res) => {
  // deterministic render from the composer — no AI
  try {
    const { ws = 'default', template_id, boxes, caption, caption_style, out_name } = req.body || {};
    const { renderMeme } = require('./engine/render.js');
    const d = ensureWs(ws);
    const file = path.join(d, 'exports', (out_name || 'meme-' + Date.now()) + '.png');
    const index = readJSON(path.join(TPL_DIR, 'index.json'), { templates: [] });
    const tpl = index.templates.find((t) => t.id === template_id);
    if (!tpl) return res.status(404).json({ error: 'template not found' });
    await renderMeme({ template: tpl, boxes, caption, captionStyle: caption_style, outPath: file, tplDir: TPL_DIR });
    res.json({ ok: true, file: '/files/' + ws + '/exports/' + path.basename(file) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'no such job' });
  res.json({ id: j.id, status: j.status, queued: !!j.queued, result: j.result, err: j.status === 'failed' ? j.err.slice(-2000) : undefined, ms: (j.ended || Date.now()) - j.started });
});

// ---------- drops (approval queue — always-on sink) ----------
app.get('/api/drops', (req, res) => {
  const ws = req.query.ws || 'default';
  res.json({ items: readJSON(path.join(ensureWs(ws), 'drops.json'), []) });
});
app.post('/api/drops/:id/status', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'drops.json');
  const drops = readJSON(p, []);
  const d = drops.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  d.status = req.body.status || d.status; // new | approved | rejected
  writeJSON(p, drops);
  res.json({ ok: true });
});

// ---------- missions ----------
app.get('/api/missions', (req, res) => {
  const ws = req.query.ws || 'default';
  res.json({ items: readJSON(path.join(ensureWs(ws), 'missions.json'), []) });
});
app.post('/api/missions', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'missions.json');
  const missions = readJSON(p, []);
  const m = req.body || {};
  if (!m.id) { m.id = 'mis-' + Date.now(); m.created = new Date().toISOString(); missions.push(m); }
  else { const i = missions.findIndex((x) => x.id === m.id); if (i >= 0) missions[i] = { ...missions[i], ...m }; else missions.push(m); }
  writeJSON(p, missions);
  res.json({ ok: true, id: m.id });
});
app.delete('/api/missions/:id', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'missions.json');
  writeJSON(p, readJSON(p, []).filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});
app.post('/api/missions/:id/run', (req, res) => {
  const ws = req.query.ws || 'default';
  const job = runJob('mission-run.js', ['--ws', ws, '--mission', req.params.id, '--force']);
  res.json({ job_id: job.id });
});

// ---------- chats (persistent, multiple, auto-named — the vendor's chat model) ----------
app.get('/api/chats', (req, res) => {
  const ws = req.query.ws || 'default';
  const chats = readJSON(path.join(ensureWs(ws), 'chats.json'), []);
  res.json({ items: chats.map((c) => ({ id: c.id, title: c.title, updated: c.updated, n: (c.messages || []).length })) });
});
app.get('/api/chats/:id', (req, res) => {
  const ws = req.query.ws || 'default';
  const chats = readJSON(path.join(ensureWs(ws), 'chats.json'), []);
  const c = chats.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'no such chat' });
  res.json(c);
});
app.post('/api/chats', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'chats.json');
  const chats = readJSON(p, []);
  const c = req.body || {};
  if (!c.id) c.id = 'chat-' + Date.now();
  c.updated = new Date().toISOString();
  const i = chats.findIndex((x) => x.id === c.id);
  if (i >= 0) chats[i] = { ...chats[i], ...c }; else chats.unshift(c);
  writeJSON(p, chats.slice(0, 100));
  res.json({ ok: true, id: c.id });
});
app.delete('/api/chats/:id', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'chats.json');
  writeJSON(p, readJSON(p, []).filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- liked templates ----------
app.post('/api/templates/:id/like', (req, res) => {
  const p = path.join(TPL_DIR, 'liked.json');
  let liked = readJSON(p, []);
  if (req.body && req.body.liked === false) liked = liked.filter((x) => x !== req.params.id);
  else if (!liked.includes(req.params.id)) liked.push(req.params.id);
  writeJSON(p, liked);
  res.json({ ok: true, liked });
});
app.get('/api/liked', (_q, res) => res.json({ liked: readJSON(path.join(TPL_DIR, 'liked.json'), []) }));

// ---------- magic prompt (AI-assist for mission briefs) ----------
app.post('/api/magic-prompt', async (req, res) => {
  try {
    const { rough = '', ws = 'default' } = req.body || {};
    const profile = readJSON(path.join(ensureWs(ws), 'profile.json'), {});
    const { askClaude } = require('./engine/claude.js');
    const out = await askClaude(
      `Turn this rough idea into a sharp recurring meme-mission brief (3-5 sentences: audience, angle, tone, what to riff on, what to avoid). Rough idea: "${rough}". ${profile.voice ? 'Brand context: ' + profile.voice : ''} Reply with ONLY the brief text.`,
      { timeoutMs: 90000 });
    res.json({ brief: out.trim() });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- library listings (uploads / exports) ----------
app.get('/api/library', (req, res) => {
  const ws = req.query.ws || 'default';
  const kind = req.query.kind === 'exports' ? 'exports' : 'assets';
  const dir = path.join(ensureWs(ws), kind);
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp|gif|mp4)$/i.test(f))
    .map((f) => ({ name: f, url: '/files/' + ws + '/' + kind + '/' + f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  res.json({ items: files });
});

// ---------- video template import ----------
app.post('/api/templates/import-video', (req, res) => {
  const { name, url, file_path, data_base64, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  let spec = { name, url, file: file_path, description };
  if (data_base64) {
    const tmp = path.join(LOG_DIR, 'upload-' + Date.now() + '.mp4');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(data_base64, 'base64'));
    spec = { name, file: tmp, description };
  }
  const job = runJob('import-video-template.js', [], { SOMEME_IMPORT: JSON.stringify(spec) });
  res.json({ job_id: job.id });
});

app.post('/api/workspace/profile', (req, res) => {
  const ws = req.query.ws || 'default';
  const p = path.join(ensureWs(ws), 'profile.json');
  writeJSON(p, { ...readJSON(p, {}), ...(req.body || {}) });
  res.json({ ok: true });
});

// ---------- AI image (Higgsfield, gated on user login) ----------
app.get('/api/ai-image/status', (_q, res) => {
  const ready = fs.existsSync(path.join(ROOT, 'logs', '.ai-image-ready'));
  const conf = readJSON(path.join(ROOT, 'ai-image.json'), {});
  res.json({ ready, model: conf.model || null });
});

// ---------- trending ----------
app.get('/api/trending', (_q, res) => res.json(readJSON(path.join(TPL_DIR, 'trending.json'), { updated: null, items: [] })));
app.post('/api/trend-scout/run', (_q, res) => res.json({ job_id: runJob('trend-scout.js', []).id }));

// ---------- workspace files ----------
app.use('/files', express.static(WS_DIR));
app.post('/api/upload', (req, res) => {
  const { ws = 'default', name = 'upload.png', data_base64 } = req.body || {};
  if (!data_base64) return res.status(400).json({ error: 'data_base64 required' });
  const d = ensureWs(ws);
  const safe = name.replace(/[^a-z0-9._-]/gi, '_');
  const file = path.join(d, 'assets', Date.now() + '-' + safe);
  fs.writeFileSync(file, Buffer.from(data_base64, 'base64'));
  res.json({ ok: true, file: '/files/' + ws + '/assets/' + path.basename(file) });
});

// ---------- start (loopback both families; second bind failure is fine) ----------
ensureWs('default');
const srv = app.listen(PORT, '127.0.0.1', () => console.log(`SoMeme on http://127.0.0.1:${PORT}`));
try {
  const srv6 = express().use(app).listen(PORT, '::1', () => console.log(`SoMeme also on [::1]:${PORT}`));
  srv6.on('error', () => {});
} catch { /* ipv6 unavailable */ }
srv.on('error', (e) => { console.error('listen failed:', e.message); process.exit(1); });
