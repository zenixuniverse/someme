// Seed the template library: imgflip's free public top-100 (widely-shared classic templates)
// + a Claude enrichment pass adding description/tags/box semantics/example captions
// (the fields the captured Memelord data model showed are what make LLM template-picking work).
// Usage: node engine/seed-templates.js [--skip-enrich] [--limit N]
const fs = require('fs');
const path = require('path');
const { askClaude, extractJSON } = require('./claude.js');

const TPL_DIR = path.join(__dirname, '..', 'templates');
const IMG_DIR = path.join(TPL_DIR, 'images');
const INDEX = path.join(TPL_DIR, 'index.json');

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function main() {
  const args = process.argv.slice(2);
  const skipEnrich = args.includes('--skip-enrich');
  const limitIx = args.indexOf('--limit');
  const limit = limitIx >= 0 ? parseInt(args[limitIx + 1], 10) : 100;

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { templates: [] };
  const have = new Set(index.templates.map((t) => t.source_ref));

  console.log('Fetching imgflip template list…');
  const resp = await fetch('https://api.imgflip.com/get_memes').then((r) => r.json());
  if (!resp.success) throw new Error('imgflip API failed');
  const memes = resp.data.memes.slice(0, limit);

  let added = 0;
  for (const m of memes) {
    const ref = 'imgflip:' + m.id;
    if (have.has(ref)) continue;
    const ext = path.extname(new URL(m.url).pathname) || '.jpg';
    const file = 'imgflip-' + m.id + ext;
    try {
      await download(m.url, path.join(IMG_DIR, file));
    } catch (e) { console.log('  skip (download failed):', m.name, e.message); continue; }
    index.templates.push({
      id: 'tpl-' + m.id,
      name: m.name,
      description: '', // enrichment fills
      tags: [],
      type: 'image',
      file,
      width: m.width, height: m.height,
      box_count: m.box_count,
      boxes: null,           // null → renderer uses classic defaults; composer can save exact layout
      example_captions: [],
      face_swappable: false,
      nsfw: false,
      source_ref: ref,
      added: new Date().toISOString(),
    });
    added++;
    if (added % 20 === 0) console.log(`  ${added} downloaded…`);
  }
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
  console.log(`Downloaded ${added} new templates (index total: ${index.templates.length}).`);

  if (skipEnrich) { console.log('RESULT:' + JSON.stringify({ added, total: index.templates.length, enriched: false })); return; }

  // ---- enrichment in chunks of 25 ----
  const need = index.templates.filter((t) => !t.description);
  console.log(`Enriching ${need.length} templates via claude…`);
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25);
    const listing = chunk.map((t) => `- id:"${t.id}" name:"${t.name}" text_boxes:${t.box_count}`).join('\n');
    const prompt = `You are building a meme template index. For each classic meme template below (you know these famous formats), return STRICT JSON — an object keyed by id, each value:
{"description": "<2-3 sentence visual description of the image and what the format expresses — written so an LLM can pick the right template for a topic>",
 "tags": ["<5-8 lowercase tags: emotions, situations, use-cases>"],
 "box_semantics": ["<meaning of each text box in order, e.g. 'rejected option', 'approved option'>"],
 "example_captions": ["<one caption per text box, forming one coherent funny example about business/marketing life>"]}

Templates:
${listing}

Return ONLY the JSON object.`;
    try {
      const out = await askClaude(prompt, { timeoutMs: 300000 });
      const data = extractJSON(out);
      let hit = 0;
      for (const t of chunk) {
        const e = data[t.id];
        if (!e) continue;
        t.description = e.description || t.description;
        t.tags = Array.isArray(e.tags) ? e.tags : t.tags;
        t.box_semantics = Array.isArray(e.box_semantics) ? e.box_semantics : undefined;
        t.example_captions = Array.isArray(e.example_captions) ? e.example_captions : t.example_captions;
        hit++;
      }
      fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
      console.log(`  chunk ${1 + i / 25}: enriched ${hit}/${chunk.length}`);
    } catch (e) {
      console.log(`  chunk ${1 + i / 25} FAILED: ${e.message} — continuing (descriptions can be backfilled)`);
    }
  }
  const enriched = index.templates.filter((t) => t.description).length;
  console.log('RESULT:' + JSON.stringify({ added, total: index.templates.length, enriched }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
