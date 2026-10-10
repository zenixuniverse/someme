// SoMeme missions engine — runs mission briefs (the $199-tier feature, local).
// Modes:
//   node engine/mission-run.js --ws default --mission mis-123 --force   (run one now)
//   node engine/mission-run.js --tick                                   (scheduler tick: run whatever is due, all workspaces)
// Triggers: schedule.mode "daily" (time + runs_per_day) or "new-trend" (trending.json newer than last_run).
// Output always lands in the workspace Drops queue; optional webhook per mission.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WS_DIR = path.join(ROOT, 'workspaces');
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
function arg(name, fb) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fb; }

const TYPE_PREAMBLE = {
  jester: '',
  ads: 'These are meme ADS for the brand: weave the brand/product into the joke natively (the way meme pages shill without killing the joke). ',
  'silly-pics': 'Go for absurd, silly, shareable image humor rather than topical news. ',
};

function spawnMemeGen({ ws, count, prompt, postText, missionId }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'meme-gen.js'), '--ws', ws, '--count', String(count)], {
      cwd: ROOT,
      env: { ...process.env, SOMEME_PROMPT: prompt, SOMEME_SOURCE: 'mission:' + missionId, ...(postText ? { SOMEME_POST_TEXT: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const m = out.split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
      let result = null; if (m) { try { result = JSON.parse(m.slice(7)); } catch {} }
      resolve({ code, result, err: err.slice(-1000) });
    });
  });
}

async function deliverWebhook(hook, memes, missionName) {
  for (const m of memes) {
    try {
      const filePath = path.join(WS_DIR, m.ws, 'drops', path.basename(m.file));
      if (hook.includes('discord.com') || hook.includes('slack.com')) {
        const fd = new FormData();
        const content = `**${missionName}** — ${m.title}${m.post_text ? '\n' + m.post_text : ''}`;
        fd.append(hook.includes('discord') ? 'payload_json' : 'content', hook.includes('discord') ? JSON.stringify({ content }) : content);
        fd.append('file', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), path.basename(filePath));
        await fetch(hook, { method: 'POST', body: fd });
      } else {
        await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mission: missionName, ...m }) });
      }
      console.log('delivered to webhook: ' + m.id);
    } catch (e) { console.log('webhook delivery failed for ' + m.id + ': ' + e.message); }
  }
}

function isDue(m, now = new Date()) {
  if (m.enabled === false) return { due: false, why: 'paused' };
  const sch = m.schedule || { mode: 'daily', time: '09:00', runs_per_day: 1 };
  const last = m.last_run ? new Date(m.last_run) : null;
  if (sch.mode === 'new-trend') {
    const tr = readJSON(path.join(ROOT, 'templates', 'trending.json'), { updated: null });
    if (!tr.updated) return { due: false, why: 'no trend data' };
    const due = !last || new Date(tr.updated) > last;
    return { due, why: due ? 'new trend batch since last run' : 'no new trends' };
  }
  // daily mode: due if we're past today's slot(s) and haven't run in this slot
  const [hh, mm] = (sch.time || '09:00').split(':').map(Number);
  const runs = Math.max(1, sch.runs_per_day || 1);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const slotMs = Math.floor((24 * 60) / runs) * 60000;
  const first = dayStart.getTime() + hh * 3600000 + mm * 60000;
  let dueSlot = null;
  for (let i = 0; i < runs; i++) {
    const slot = first + i * slotMs;
    if (now.getTime() >= slot && (!last || last.getTime() < slot)) dueSlot = slot;
  }
  return { due: dueSlot != null, why: dueSlot != null ? 'slot reached' : 'not yet' };
}

// silly-pics missions use Higgsfield generative images when set up; else fall back to template memes
async function runSillyPics(ws, m) {
  const { askClaude, extractJSON } = require('./claude.js');
  const { spawnSync } = require('child_process');
  const n = Math.min(4, m.count || 1);
  const out = await askClaude(`Write ${n} distinct, funny, brand-safe AI image prompts for: "${m.prompt}". Silly, shareable, meme-adjacent. STRICT JSON: {"prompts":["…"]}. ONLY JSON.`, { timeoutMs: 90000 });
  const prompts = (extractJSON(out).prompts || []).slice(0, n);
  const dropsPath = path.join(WS_DIR, ws, 'drops.json');
  const drops = readJSON(dropsPath, []);
  const made = [];
  for (const p of prompts) {
    const id = 'silly-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const outFile = path.join(WS_DIR, ws, 'drops', id + '.png');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'ai-image.js'), '--generate', '--prompt', p, '--out', outFile], { encoding: 'utf8', timeout: 700000 });
    if (r.status === 0 && fs.existsSync(outFile)) {
      const entry = { id, ws, status: 'new', file: '/files/' + ws + '/drops/' + id + '.png', title: p.slice(0, 70), template_name: 'AI image (Higgsfield)', type: 'image', render_mode: 'ai-image', prompt: p, source: 'mission:' + m.id, created: new Date().toISOString() };
      drops.unshift(entry); made.push(entry);
      console.log('silly pic done: ' + id);
    } else console.log('silly pic FAILED: ' + (r.stdout || '').slice(-200));
  }
  fs.writeFileSync(dropsPath, JSON.stringify(drops, null, 2));
  return made;
}

async function runMission(ws, m) {
  if (m.type === 'silly-pics' && require('./ai-image.js').isReady()) {
    const made = await runSillyPics(ws, m);
    console.log(`mission "${m.name}": ${made.length} AI images → Drops`);
    if (m.delivery?.webhook && made.length) await deliverWebhook(m.delivery.webhook, made, m.name);
    if (m.notify !== false && made.length) require('./toast.js').toast('SoMeme — ' + m.name, made.length + ' new AI image' + (made.length > 1 ? 's' : '') + ' in Drops');
    return made.length;
  }
  if (m.type === 'silly-pics') console.log('note: Higgsfield not set up (engine/ai-image.js --check) — falling back to template memes');
  const preamble = TYPE_PREAMBLE[m.type] || '';
  const trending = readJSON(path.join(ROOT, 'templates', 'trending.json'), { items: [] });
  const trendCtx = m.schedule?.mode === 'new-trend' && trending.items.length
    ? `\nFresh trending formats right now: ${trending.items.slice(0, 5).map((t) => t.name + ' (' + (t.why_trending || '') + ')').join('; ')}. Lean into one of these.`
    : '';
  const prompt = preamble + (m.prompt || 'Make funny relatable memes for this brand.') + trendCtx;
  console.log(`running mission "${m.name}" (${m.id}) in ws ${ws}…`);
  const r = await spawnMemeGen({ ws, count: Math.min(4, m.count || 1), prompt, postText: m.generate_post_text, missionId: m.id });
  const memes = r.result?.memes || [];
  console.log(`mission "${m.name}": ${memes.length} memes → Drops${r.code !== 0 ? ' (engine exit ' + r.code + ')' : ''}`);
  if (r.code !== 0 && !memes.length) console.log('engine stderr: ' + r.err);
  if (m.delivery?.webhook && memes.length) await deliverWebhook(m.delivery.webhook, memes, m.name);
  if (m.notify !== false && memes.length) require('./toast.js').toast('SoMeme — ' + m.name, memes.length + ' new meme' + (memes.length > 1 ? 's' : '') + ' in Drops (' + ws + ')');
  return memes.length;
}

async function main() {
  const tick = process.argv.includes('--tick');
  const force = process.argv.includes('--force');
  const targetWs = arg('--ws', null);
  const targetMission = arg('--mission', null);
  let total = 0, ran = 0;

  const workspaces = targetWs ? [targetWs] : fs.readdirSync(WS_DIR).filter((f) => fs.statSync(path.join(WS_DIR, f)).isDirectory());
  for (const ws of workspaces) {
    const mPath = path.join(WS_DIR, ws, 'missions.json');
    const missions = readJSON(mPath, []);
    for (const m of missions) {
      if (targetMission && m.id !== targetMission) continue;
      const { due, why } = force ? { due: true, why: 'forced' } : isDue(m);
      if (!due) { if (tick) console.log(`skip "${m.name}" (${ws}): ${why}`); continue; }
      const n = await runMission(ws, m);
      m.last_run = new Date().toISOString();
      m.run_count = (m.run_count || 0) + 1;
      writeJSON(mPath, missions);
      total += n; ran++;
    }
  }
  console.log('RESULT:' + JSON.stringify({ missions_ran: ran, memes: total }));
}

main().catch((e) => { console.error('MISSION ERROR: ' + (e.stack || e)); process.exitCode = 1; });
