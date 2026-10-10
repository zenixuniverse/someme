# SoMeme — local meme marketing OS

Functional rebuild of memelord.com (Agent tier, $199/mo → $0). Original code and branding; their expression stays theirs. Teardown docs: `E:\Projects\Memelord_Local_Rebuild\` (PLAYBOOK.md + CAPTURE.md).

## Start

```
E:\Projects\SoMeme\start.bat        → http://127.0.0.1:8797
```

Requirements already in place: Node 24, `claude` CLI on PATH. Loopback-only bind (127.0.0.1 + ::1).

## UI: SoMeme OS (default) + classic

The default UI is **SoMeme OS** — a retro-desktop shell matching the interaction model captured from the vendor's real dashboard (left template-vault window, center chat window with Chats/Missions/New Chat in the title bar, desktop icons for Missions/Drops/Trends/Composer/Settings, draggable/overlapping windows, template-click → attach card with Caption / Use AI). Branding, palette (crimson chrome), wordmark, mascot, icons, and copy are all SoMeme's own — the layout/IA is what's reproduced, not their identity.

The previous flat dashboard remains at `/app/classic.html` (also via Menu → Classic UI).

## What's inside

| Surface | Memelord equivalent | Where |
|---|---|---|
| **Make** (chat with the meme agent) | Jester chat | dashboard `?view=make` — prompt → template pick + captions → result cards with Edit / Composer / Approve / suggestion chips |
| **The Vault** (left panel) | Dank Bank | 100 classic templates seeded from imgflip's public API, Claude-enriched with descriptions/tags/box semantics/example captions + custom layouts for non-classic formats; importer for any image (`engine/import-template.js`) |
| **Feed** | Trending meme alerts | `engine/trend-scout.js` — Claude + WebSearch sweep → heat-tiered feed + new-trend events. Scheduled 08:00/16:00 |
| **Missions** | Agent Jester missions ($199 tier) | brief + type (jester/ads/silly-pics) + trigger (daily slots OR "new-trend" = their Baller Mode) + memes/run + post-text toggle + optional webhook. `engine/mission-run.js --tick` every 30 min |
| **Drops** | mission gallery | always-on approval queue; nothing ever auto-posts |
| **Composer** | Meme Composer | draggable/resizable text boxes, caption modes (top/tiktok/snapchat), export PNG, save layout back to template |
| **MCP** | their hosted MCP | `mcp/server.js` — generate_meme, edit_meme, list_templates, get_trending, run_trend_scout, check_job. Register: `claude mcp add someme -s user -- cmd.exe /c node E:\Projects\SoMeme\mcp\server.js` |

## Scheduler (user runs this once)

```
powershell -ExecutionPolicy Bypass -File E:\Projects\SoMeme\install-task.ps1
```

Creates: server-at-logon, mission tick (30 min), trend scout (8am/4pm). `-Remove` uninstalls.

## Architecture notes

- `workspaces/<brand>/` — profile.json (voice, banned topics), missions.json, drops.json, drops/ + exports/ PNGs. Multi-client native; switch in the header.
- `templates/index.json` — the library. Fields mirror the vendor's captured data model (description/tags drive LLM template picking; `boxes` = percent-rect layout, null → classic top/bottom).
- All AI = `claude -p` via `cmd.exe /c` with the prompt on stdin (`engine/claude.js`). No API keys, no credits.
- Engines are standalone-runnable AND server-spawned (`stdio ignore/pipe/pipe`, both streams drained).
- Renders: sharp + SVG text (Impact-style stroke). `node engine/render.js` = font self-test.

## Deep-dive parity additions (2026-08-05, all verified e2e)

- **Video memes** — `engine/video-meme.js`: captioned video templates in their two styles (top letterbox / TikTok centered pills), same sharp text raster as images, audio preserved. Import clips via Vault → Videos → + Import (URL or local path; auto-preview + Claude description) or `engine/import-video-template.js`. Chat picks video templates when you ask for a video.
- **Persistent multi-chats** — auto-named, deep-linked (`?chat=`), drawer via ☰, survive reloads. Per workspace.
- **Composer toolbar** — per-box size/color/align/uppercase/outline/font + presets (Impact/Clean/Minimal), delete box; server render honors every knob.
- **Library** — Vault → Library: Uploads / Exports; Liked hearts on templates (their LIKED tab); upload-into-chat (+ button imports your image as a template and attaches it).
- **Magic prompt** — ✨ in the mission form turns a rough idea into a full brief.
- **Windows toasts** — mission completions + new-trend alerts (their push notifications), per-mission toggle.
- **Drops** — filter by source (chat / per-mission); mission Duplicate action.
- **AI Silly Pics via Higgsfield** — `engine/ai-image.js`; silly-pics missions generate real AI images once you run `higgsfield auth login` + `node engine/ai-image.js --check`. Until then they fall back to template memes (graceful).

## Full library harvest (captured before cancellation, 2026-08-05)

Their entire public template library (~7,662 assets: ~5,000 images + 2,604 video clips) is mirrored locally so it survives the account closing. These are third-party cultural meme artifacts on a public bucket (no auth), copied with their factual metadata (names, dimensions, and normalized text-box geometry → our composer layouts). Descriptions carried over as functional LLM-matching metadata, flagged `desc_source:"vendor"` for optional re-enrichment on our own schedule.

- `engine/harvest-memelord.js` — resumable download of all media + previews to `templates/harvest/` + `manifest.json`. Re-run any time; skips files already on disk.
- `engine/merge-harvest.js` — folds the manifest into `templates/index.json` (imports box geometry, points at local media). Idempotent.
- Media served at `/templates/harvest/...`; render/video engines resolve both harvest sub-paths and the imgflip seed's bare filenames.
- `engine/enrich-harvest.js` — **all 7,662 descriptions/tags/example-captions regenerated in SoMeme's own voice** (2026-08-11). The vendor's scene text was used as reference only; output is original, reframed around what each format *means and is used for* (better for LLM template-picking), flagged `desc_source:"someme"`. Batched (30/call), resumable, atomic writes so the live server never reads a partial index. Re-run any time to refresh; it only touches `desc_source:"vendor"`.

## Known gaps vs the vendor (honest)

- **Video template library**: pipeline is done, but no legal bulk source for their clip collection — import clips yourself (one URL/file at a time, described automatically).
- **Trend freshness**: our scout runs on schedule (2×/day + on-demand); their editorial team is near-real-time.
- **Face-swap**: not built — needs Higgsfield login first, and their face-swap missions depend on a swap-capable model; revisit after `--check`.
- **Buffer/Typefully/X auto-posting**: deliberately not wired (Drops-approval-first was the chosen design).
- **iOS app**: no. Dashboard is responsive on LAN.
