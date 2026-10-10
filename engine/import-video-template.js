// Import a video template (local file path or URL) into the library:
// copies to templates/videos/, extracts a preview frame, appends an index entry,
// and (unless --skip-describe) has Claude write description/tags from the name you give it.
//   node engine/import-video-template.js --file "C:\clips\my.mp4" --name "Guy blinking" [--desc "..."] [--dry-run]
//   node engine/import-video-template.js --url https://…/clip.mp4 --name "…"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg, probe } = require('./ffmpeg.js');

const TPL_DIR = path.join(__dirname, '..', 'templates');
const INDEX = path.join(TPL_DIR, 'index.json');
function arg(name, fb) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fb; }

async function main() {
  const spec = process.env.SOMEME_IMPORT ? JSON.parse(process.env.SOMEME_IMPORT)
    : { name: arg('--name', ''), file: arg('--file', ''), url: arg('--url', ''), description: arg('--desc', '') };
  const dry = process.argv.includes('--dry-run');
  if (!spec.name) throw new Error('--name required');
  if (!spec.file && !spec.url) throw new Error('--file or --url required');

  const id = 'vtpl-' + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(path.join(TPL_DIR, 'videos'), { recursive: true });
  let src = spec.file;
  if (spec.url) {
    const r = await fetch(spec.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('download failed HTTP ' + r.status);
    src = path.join(TPL_DIR, 'videos', id + '.download');
    fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
  }
  const info = probe(src);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');
  const duration = parseFloat(info.format.duration);
  console.log(`parsed: ${spec.name} ${v.width}x${v.height} ${duration.toFixed(1)}s`);
  if (dry) { console.log('RESULT:' + JSON.stringify({ dry_run: true, width: v.width, height: v.height, duration })); return; }

  const file = id + '.mp4';
  const dest = path.join(TPL_DIR, 'videos', file);
  // normalize container to mp4/h264 so downstream render is uniform
  await runFfmpeg(['-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', dest]).catch(async () => {
    await runFfmpeg(['-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', dest]);
  });
  const preview = id + '.jpg';
  await runFfmpeg(['-ss', String(Math.min(1, duration / 3)), '-i', dest, '-frames:v', '1', '-q:v', '4', path.join(TPL_DIR, 'videos', preview)]);
  if (spec.url) try { fs.rmSync(src); } catch {}

  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { templates: [] };
  index.templates.unshift({
    id, name: spec.name,
    description: spec.description || '',
    tags: spec.tags || [], type: 'video',
    file, preview,
    width: v.width, height: v.height, duration,
    box_count: 1, boxes: null, example_captions: [],
    face_swappable: false, nsfw: !!spec.nsfw,
    source_ref: spec.url ? 'import:' + spec.url : 'import:' + (spec.file || 'upload'),
    added: new Date().toISOString(),
  });
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));

  if (!spec.description && !process.argv.includes('--skip-describe')) {
    try {
      const { askClaude, extractJSON } = require('./claude.js');
      const out = await askClaude(`Meme video template named "${spec.name}" (${duration.toFixed(0)}s). Write STRICT JSON {"description":"<2 sentences: what likely happens in the clip and what reaction/format it expresses — for an LLM to match topics to it>","tags":["<5 lowercase tags>"]}. ONLY JSON.`, { timeoutMs: 60000 });
      const d = extractJSON(out);
      const t = index.templates.find((x) => x.id === id);
      t.description = d.description || ''; t.tags = d.tags || [];
      fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
      console.log('described via claude');
    } catch (e) { console.log('describe skipped: ' + e.message); }
  }
  console.log('RESULT:' + JSON.stringify({ imported: id, duration }));
}

main().catch((e) => { console.error('IMPORT ERROR: ' + (e.stack || e)); process.exitCode = 1; });
