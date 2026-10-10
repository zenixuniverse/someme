// SoMeme generation engine — the "Jester" equivalent.
// prompt → Claude picks template(s) from the local index + writes captions → render → Drops entry.
// Runnable standalone AND spawned by the server. Env contract (set by server):
//   SOMEME_PROMPT, SOMEME_TEMPLATE (optional id), SOMEME_STYLE (top|tiktok|snapchat|''), SOMEME_HISTORY (json), SOMEME_ARTIFACT (edit mode)
// Output: progress lines + final "RESULT:{json}" line.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { askClaude, extractJSON } = require('./claude.js');
const { renderMeme } = require('./render.js');

const ROOT = path.join(__dirname, '..');
const TPL_DIR = path.join(ROOT, 'templates');

function arg(name, fb) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fb; }
const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

// The harvested library ships with nsfw:false on every template, so the flag alone filters nothing.
// ponytail: keyword screen on name/tags/description — catches the crude/violent ones (~400 of 7.7k) with some
// false positives (e.g. "Always Has Been" has a gun); those stay usable via an explicit template_id.
const UNSAFE = /\b(fuck\w*|shit\w*|sex\w*|porn\w*|jerk\w*|suicid\w*|nude\w*|naked|cum|dick\w*|cock\w*|pussy|nsfw|guns?|gunpoint|pistol|shoot\w*|kill\w*|rape\w*|nazi\w*|hitler|cocaine|drugs?|weed|bitch\w*|ass|asshole|retard\w*|n[i1]gg\w*|fag\w*|masturbat\w*|horny|boob\w*|tits?|hoes?|joint|blunt|stoner|420|blood\w*|gore)\b/i;
const isUnsafe = (t) => !!t.nsfw || UNSAFE.test(t.name + ' ' + (t.tags || []).join(' ') + ' ' + (t.description || ''));
// Harvested templates carry box geometry in % of the image; ~1.4k have sliver boxes (a YouTube UI label,
// a sign in the corner) where any caption renders unreadable. Classic default layouts (boxes:null) are fine.
// Also skip layouts whose boxes pile on top of each other or run off the image (e.g. "Death Is Knocking").
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const tinyBoxes = (t) => Array.isArray(t.boxes) && t.boxes.some((b, i) =>
  b.w < 18 || b.h < 5 || b.x < -3 || b.y < -3 || b.x + b.w > 103 || b.y + b.h > 103 ||
  t.boxes.some((c, j) => j > i && overlap(b, c) > 0.25 * Math.min(b.w * b.h, c.w * c.h)));
const wantsVideo = (prompt) => /\b(video|gif|reel|clip|animated|animation)s?\b/i.test(prompt);

function catalogSlice(index, { hint = '', max = 60, allowNsfw = false, allowVideo = false } = {}) {
  // keep prompt lean: prefer described templates; simple relevance boost by hint keywords.
  // Video templates ride along labelled [VIDEO] only when the request asks for video — otherwise the
  // model drifts into them for image requests (they only support caption mode).
  let items = index.templates.filter((t) => (allowNsfw || !isUnsafe(t)) && (allowVideo || t.type !== 'video') && (t.type === 'video' || !tinyBoxes(t)));
  const words = hint.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const score = (t) => {
    const hay = (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLowerCase();
    return words.reduce((a, w) => a + (hay.includes(w) ? 2 : 0), 0) + (t.description ? 1 : 0);
  };
  items = items.sort((a, b) => score(b) - score(a)).slice(0, max);
  return items.map((t) => (t.type === 'video' ? '[VIDEO] ' : '') + `id:"${t.id}" | ${t.name} | boxes:${t.box_count}${t.box_semantics ? ' (' + t.box_semantics.join(' / ') + ')' : ''} | ${(t.description || '').slice(0, 160)}`).join('\n');
}

async function main() {
  const ws = arg('--ws', 'default');
  const count = Math.min(4, parseInt(arg('--count', '1'), 10) || 1);
  const editMode = process.argv.includes('--edit');
  const prompt = process.env.SOMEME_PROMPT || '';
  const forcedTemplate = process.env.SOMEME_TEMPLATE || '';
  const style = process.env.SOMEME_STYLE || '';
  const history = readJSONEnv('SOMEME_HISTORY', []);
  const artifact = readJSONEnv('SOMEME_ARTIFACT', null);

  const index = readJSON(path.join(TPL_DIR, 'index.json'), { templates: [] });
  if (!index.templates.length) throw new Error('template index empty — run engine/seed-templates.js first');
  const wsDir = path.join(ROOT, 'workspaces', ws);
  const profile = readJSON(path.join(wsDir, 'profile.json'), {});
  const dropsPath = path.join(wsDir, 'drops.json');

  let plan;
  if (editMode && artifact) {
    plan = await planEdit({ prompt, artifact, index });
  } else {
    plan = await planGenerate({ prompt, count, forcedTemplate, style, history, index, profile });
  }

  const results = [];
  for (const item of plan.memes) {
    const tpl = index.templates.find((t) => t.id === item.template_id);
    if (!tpl) { console.log('skip: unknown template ' + item.template_id); continue; }
    if (!item.caption && !(item.texts || []).some((s) => String(s).trim())) { console.log('skip: no text for ' + tpl.id); continue; }
    const id = 'meme-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
    const isVideo = tpl.type === 'video';
    const outPath = path.join(wsDir, 'drops', id + (isVideo ? '.mp4' : '.png'));
    if (isVideo) {
      const { renderVideoMeme } = require('./video-meme.js');
      const { resolveTemplateFile } = require('./render.js');
      const vstyle = ['top', 'tiktok'].includes(item.caption_style || style) ? (item.caption_style || style) : (tpl.height > tpl.width ? 'tiktok' : 'top');
      await renderVideoMeme({ videoPath: resolveTemplateFile(tpl.file, TPL_DIR, 'videos'), caption: item.caption || (item.texts || []).join(' '), style: vstyle, outPath });
      item.caption = item.caption || (item.texts || []).join(' ');
      item.caption_style = vstyle;
    } else {
      const renderSpec = item.caption
        ? { template: tpl, caption: item.caption, captionStyle: item.caption_style || style || 'top', outPath, tplDir: TPL_DIR }
        : { template: tpl, boxes: (item.texts || []).map((text, i) => ({ ...( (tpl.boxes || [])[i] || {} ), text })), outPath, tplDir: TPL_DIR };
      // null boxes → render.js falls back to classic defaults by box_count
      if (!item.caption && (!renderSpec.boxes || !renderSpec.boxes.length)) renderSpec.boxes = null;
      await renderMeme(renderSpec);
    }
    const entry = {
      id,
      ws,
      status: 'new',
      file: '/files/' + ws + '/drops/' + id + (isVideo ? '.mp4' : '.png'),
      title: item.title || prompt.slice(0, 80),
      template_id: tpl.id,
      template_name: tpl.name,
      type: isVideo ? 'video' : 'image',
      render_mode: isVideo ? 'video' : (item.caption ? 'caption' : 'template'),
      caption: item.caption || null,
      caption_style: item.caption ? (item.caption_style || style || 'top') : null,
      texts: item.texts || null,
      prompt,
      commentary: plan.commentary || '',
      suggestions: plan.suggestions || [],
      post_text: item.post_text || null,
      source: process.env.SOMEME_SOURCE || (editMode ? 'edit' : 'chat'),
      created: new Date().toISOString(),
    };
    results.push(entry);
    console.log('rendered ' + id + ' on "' + tpl.name + '"');
  }
  // Re-read right before writing: jobs run in parallel, and writing the copy loaded at startup
  // silently dropped whatever other jobs had saved in the meantime. tmp+rename so a reader never sees half a file.
  const fresh = readJSON(dropsPath, []);
  const tmp = dropsPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...results.slice().reverse(), ...fresh], null, 2));
  try { fs.renameSync(tmp, dropsPath); } catch { fs.copyFileSync(tmp, dropsPath); fs.unlinkSync(tmp); } // Windows EPERM if a reader holds it
  console.log('RESULT:' + JSON.stringify({ memes: results, commentary: plan.commentary || '', suggestions: plan.suggestions || [] }));
}

module.exports = { isUnsafe, tinyBoxes, wantsVideo, catalogSlice, fixBoxCounts };

function readJSONEnv(name, fb) { try { return process.env[name] ? JSON.parse(process.env[name]) : fb; } catch { return fb; } }

async function planGenerate({ prompt, count, forcedTemplate, style, history, index, profile }) {
  const forced = forcedTemplate && index.templates.find((t) => t.id === forcedTemplate);
  if (forcedTemplate && !forced) throw new Error('unknown template_id ' + forcedTemplate);
  const catalog = forced
    ? catalogSlice({ templates: [forced] }, { allowNsfw: true, allowVideo: true }) // explicit pick: describe THAT template
    : catalogSlice(index, { hint: prompt, max: 60, allowNsfw: !!profile.nsfw, allowVideo: wantsVideo(prompt) });
  const histText = history.length ? '\nRecent conversation:\n' + history.map((h) => `${h.role}: ${String(h.text).slice(0, 200)}`).join('\n') : '';
  const brand = profile.voice ? `\nBrand voice/context: ${profile.voice}. Banned topics: ${(profile.banned_topics || []).join(', ') || 'none'}.` : '';
  const p = `You are a sharp meme copywriter for marketers. Task: create ${count} meme${count > 1 ? 's' : ''} for this request:
"${prompt}"${brand}${histText}

Template catalog (pick the BEST fit by the format's meaning, not just keywords):
${catalog}

Rules:
- Respond with STRICT JSON only.
- For each meme choose ONE of two render modes:
  a) "texts": array with EXACTLY boxes:N entries — one short line per template text box, never more (extra lines get crammed and garble the image); match the box semantics; punchy, no hashtags;
  b) "caption": a single relatable one-liner rendered as a bar over the image (use when the image is a pure reaction shot${style ? `; caption_style must be "${style}"` : ''}).
- [VIDEO] templates ONLY take mode (b) caption, with caption_style "top" or "tiktok". Pick a video when the user asks for a video meme.
- ${forcedTemplate ? `You MUST use template_id "${forcedTemplate}".` : 'Vary templates across memes.'}
- Also write "commentary": one wry sentence to show the user (your voice: dry, funny, no emoji spam).
- And "suggestions": 3 short follow-up chips (e.g. "Make it more savage", "Turn it into a video", a topical variant).${process.env.SOMEME_POST_TEXT ? '\n- For each meme also write "post_text": a ready-to-post social caption (1-2 lines, no hashtag spam).' : ''}

JSON shape:
{"memes":[{"template_id":"tpl-…","title":"<short>","texts":["…"] OR "caption":"…","caption_style":"top|tiktok|snapchat"${process.env.SOMEME_POST_TEXT ? ',"post_text":"…"' : ''}}],"commentary":"…","suggestions":["…","…","…"]}`;
  const out = await askClaude(p, { timeoutMs: 180000 });
  const plan = extractJSON(out);
  if (!plan.memes || !Array.isArray(plan.memes)) throw new Error('model returned no memes array');
  if (forcedTemplate) plan.memes.forEach((m) => (m.template_id = forcedTemplate));
  return fixBoxCounts(plan, index);
}

// Too many lines for a template's boxes renders as overlapping, unreadable text. Ask once to rewrite the
// offenders; anything still over gets its overflow folded into the last box so the image stays readable.
async function fixBoxCounts(plan, index, ask = askClaude) {
  const boxes = (m) => (index.templates.find((t) => t.id === m.template_id) || {}).box_count || 0;
  const over = (m) => !m.caption && Array.isArray(m.texts) && boxes(m) > 0 && m.texts.length > boxes(m);
  const bad = plan.memes.filter(over);
  if (bad.length) {
    try {
      const fixed = extractJSON(await ask(`Rewrite these meme texts so each array has AT MOST the given number of lines. Keep the joke; merge or cut lines.
${bad.map((m, i) => `${i}. max ${boxes(m)} lines: ${JSON.stringify(m.texts)}`).join('\n')}
Respond with STRICT JSON: {"texts":[[...],[...]]} — one array per item, same order.`, { timeoutMs: 90000 }));
      bad.forEach((m, i) => { if (Array.isArray(fixed.texts?.[i]) && fixed.texts[i].length) m.texts = fixed.texts[i]; });
    } catch (e) { console.log('box-count repair failed: ' + e.message); }
    for (const m of plan.memes.filter(over)) { const n = boxes(m); m.texts = [...m.texts.slice(0, n - 1), m.texts.slice(n - 1).join(' ')]; }
  }
  return plan;
}

async function planEdit({ prompt, artifact, index }) {
  const tpl = index.templates.find((t) => t.id === artifact.template_id);
  const current = artifact.render_mode === 'caption'
    ? `caption: "${artifact.caption}" (style ${artifact.caption_style})`
    : `texts: ${JSON.stringify(artifact.texts)}`;
  const p = `Edit this existing meme. Template: "${tpl ? tpl.name : artifact.template_id}"${tpl && tpl.box_semantics ? ' (boxes: ' + tpl.box_semantics.join(' / ') + ')' : ''}.
Current ${current}
Instruction: "${prompt}"

Respond with STRICT JSON, same render mode as the current meme unless the instruction demands otherwise:
{"memes":[{"template_id":"${artifact.template_id}","title":"<short>","texts":[…] OR "caption":"…","caption_style":"${artifact.caption_style || 'top'}"}],"commentary":"<one-line summary of what changed>","suggestions":["…","…","…"]}`;
  const out = await askClaude(p, { timeoutMs: 120000 });
  return fixBoxCounts(extractJSON(out), index);
}

if (require.main === module) main().catch((e) => { console.error('ENGINE ERROR: ' + (e.stack || e)); process.exitCode = 1; });
