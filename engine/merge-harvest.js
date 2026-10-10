// Fold the harvested Memelord library into SoMeme's template index.
// - Media is served from templates/harvest/{media,previews} (see server static route added for it).
// - Box geometry is imported from their normalized text_position_data / composer_template
//   (factual layout data), converted to our percent-rect format.
// - Names + dimensions kept (factual identifiers). Descriptions/tags: we take their
//   visual text as a STARTING point flagged desc_source:'vendor' so our own enrichment
//   (engine/enrich-harvest.js) can regenerate them on our schedule — media is already safe.
// Idempotent: re-run any time; updates in place by source_ref.
//   node engine/merge-harvest.js [--only-with-media]
const fs = require('fs');
const path = require('path');

const TPL = path.join(__dirname, '..', 'templates');
const HARVEST = path.join(TPL, 'harvest');
const MANIFEST = path.join(HARVEST, 'manifest.json');
const MEDIA = path.join(HARVEST, 'media');
const PREV = path.join(HARVEST, 'previews');
const INDEX = path.join(TPL, 'index.json');

function boxesFromGeometry(a) {
  // prefer explicit composer_template elements; fall back to text_position_data
  const src = (a.composer_template && Array.isArray(a.composer_template.elements) && a.composer_template.elements.filter((e) => e.type === 'text')) || null;
  const list = src && src.length ? src : (Array.isArray(a.text_position_data) ? a.text_position_data : null);
  if (!list || !list.length) return null;
  const boxes = list.map((b) => ({
    x: Math.round((b.x || 0) * 1000) / 10,
    y: Math.round((b.y || 0) * 1000) / 10,
    w: Math.round((b.width != null ? b.width : 0.4) * 1000) / 10,
    h: Math.round((b.height != null ? b.height : 0.12) * 1000) / 10,
  })).filter((b) => [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 100) && b.w > 0 && b.h > 0);
  return boxes.length ? boxes : null;
}

function findFile(dir, id) {
  for (const ext of ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.mp4']) {
    if (fs.existsSync(path.join(dir, id + ext))) return id + ext;
  }
  return null;
}

function main() {
  const onlyWithMedia = process.argv.includes('--only-with-media');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { templates: [] };
  const bySource = new Map(index.templates.map((t) => [t.source_ref, t]));

  let added = 0, updated = 0, skipped = 0, withBoxes = 0;
  for (const a of manifest.assets) {
    const ref = 'memelord:' + a.id;
    const isVideo = a.type === 'video';
    const mediaFile = findFile(MEDIA, a.id);
    const prevFile = findFile(PREV, a.id);
    if (onlyWithMedia && !mediaFile) { skipped++; continue; }

    const boxes = isVideo ? null : boxesFromGeometry(a);
    if (boxes) withBoxes++;
    const entry = {
      id: 'ml-' + a.id.slice(0, 8),
      name: a.name,
      description: a.visual_description || a.description || '',
      desc_source: (a.visual_description || a.description) ? 'vendor' : '',   // flag for our re-enrichment
      tags: [...new Set([...(a.tags || []), ...(a.extra_tags || [])])].slice(0, 12),
      type: isVideo ? 'video' : 'image',
      file: mediaFile ? ('harvest/media/' + mediaFile) : null,   // relative to templates/, served by /templates route
      preview: prevFile ? ('harvest/previews/' + prevFile) : null,
      width: a.width, height: a.height,
      box_count: boxes ? boxes.length : (isVideo ? 1 : 2),
      boxes,
      example_captions: [],
      face_swappable: a.face_swappable,
      force_top_caption: a.force_top_caption,
      nsfw: false,
      copyright_free: a.copyright_free,
      source_ref: ref,
      library: 'memelord',
      added: new Date().toISOString(),
    };
    const existing = bySource.get(ref);
    if (existing) { Object.assign(existing, entry, { added: existing.added }); updated++; }
    else { index.templates.push(entry); bySource.set(ref, entry); added++; }
  }

  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
  const imgs = index.templates.filter((t) => t.type !== 'video').length;
  const vids = index.templates.filter((t) => t.type === 'video').length;
  console.log(`merged: +${added} new, ${updated} updated, ${skipped} skipped(no media). Boxes imported: ${withBoxes}.`);
  console.log(`index now: ${index.templates.length} templates (${imgs} image, ${vids} video)`);
  console.log('RESULT:' + JSON.stringify({ added, updated, skipped, withBoxes, total: index.templates.length }));
}

main();
