// Import a template into the library from a URL or base64 payload.
// Server sets SOMEME_IMPORT={name, url?|image_base64?, description?, tags?, nsfw?}; also runnable:
//   node engine/import-template.js --url https://… --name "My template" [--dry-run]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TPL_DIR = path.join(__dirname, '..', 'templates');
const INDEX = path.join(TPL_DIR, 'index.json');
function arg(name, fb) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fb; }

async function main() {
  const spec = process.env.SOMEME_IMPORT ? JSON.parse(process.env.SOMEME_IMPORT)
    : { name: arg('--name', ''), url: arg('--url', ''), description: arg('--desc', ''), tags: [] };
  const dry = process.argv.includes('--dry-run');
  if (!spec.name) throw new Error('name required');
  if (!spec.url && !spec.image_base64) throw new Error('url or image_base64 required');

  let buf, ext = '.png';
  if (spec.url) {
    const r = await fetch(spec.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('download failed HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image')) throw new Error('not an image: ' + ct);
    ext = '.' + (ct.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    buf = Buffer.from(spec.image_base64, 'base64');
  }

  const sharp = require('sharp');
  const meta = await sharp(buf).metadata();
  const id = 'tpl-imp-' + crypto.randomBytes(4).toString('hex');
  const file = id + ext;
  const entry = {
    id, name: spec.name,
    description: spec.description || '',
    tags: spec.tags || [],
    type: 'image', file,
    width: meta.width, height: meta.height,
    box_count: spec.box_count || 2,
    boxes: null, example_captions: [],
    face_swappable: false, nsfw: !!spec.nsfw,
    source_ref: spec.url ? 'import:' + spec.url : 'import:upload',
    added: new Date().toISOString(),
  };
  console.log(`parsed: ${spec.name} ${meta.width}x${meta.height} ${Math.round(buf.length / 1024)}KB`);
  if (dry) { console.log('RESULT:' + JSON.stringify({ dry_run: true, entry })); return; }

  fs.mkdirSync(path.join(TPL_DIR, 'images'), { recursive: true });
  fs.writeFileSync(path.join(TPL_DIR, 'images', file), buf);
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { templates: [] };
  index.templates.unshift(entry);
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
  console.log('RESULT:' + JSON.stringify({ imported: entry.id, total: index.templates.length }));
}

main().catch((e) => { console.error('IMPORT ERROR: ' + (e.stack || e)); process.exitCode = 1; });
