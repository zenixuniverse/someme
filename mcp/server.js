#!/usr/bin/env node
// SoMeme MCP server — the local equivalent of Memelord's hosted MCP (generate_meme, edit_meme, …)
// but with no credits, no expiring URLs: files land on disk, paths come back absolute.
// Talks to the running SoMeme server (http://127.0.0.1:8797) so jobs/drops stay in one place.
// Register (user scope):  claude mcp add someme -s user -- cmd.exe /c node E:\Projects\SoMeme\mcp\server.js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

const BASE = 'http://127.0.0.1:8797';
const ROOT = path.join(__dirname, '..');
const GRACE_MS = 45000; // finish inline if quick, else hand back a job id (MCP clients time out ~60s)

async function api(p, body) {
  const r = await fetch(BASE + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
}
async function ensureUp() {
  try { const h = await api('/api/health'); if (h.ok) return; } catch {}
  throw new Error('SoMeme server is not running. Start it first: E:\\Projects\\SoMeme\\start.bat (or `node server.js` in E:\\Projects\\SoMeme).');
}
function absFiles(result) {
  // rewrite web paths to absolute disk paths for the agent
  for (const m of result?.memes || []) if (m.file?.startsWith('/files/')) m.file_abs = path.join(ROOT, 'workspaces', m.file.replace('/files/', '').replace(/\//g, path.sep));
  return result;
}
async function waitJob(jobId) {
  const start = Date.now();
  while (Date.now() - start < GRACE_MS) {
    const j = await api('/api/jobs/' + jobId);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { status: 'running', id: jobId };
}
const J = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: 'someme', version: '0.1.0' });

server.registerTool('generate_meme', {
  title: 'Generate meme(s)',
  description: 'Generate 1-4 image memes from a prompt using the local template library + Claude captioning. Returns file paths on disk (workspace Drops). Use check_job if status comes back "running".',
  inputSchema: {
    prompt: z.string().describe('Topic or idea for the meme'),
    count: z.number().min(1).max(4).optional().describe('How many (default 1)'),
    workspace: z.string().optional().describe('Workspace/brand (default "default")'),
    template_id: z.string().optional().describe('Force a specific template id (from list_templates)'),
    caption_style: z.enum(['top', 'tiktok', 'snapchat']).optional().describe('Force caption-bar mode in this style'),
  },
}, async ({ prompt, count = 1, workspace = 'default', template_id = '', caption_style = '' }) => {
  await ensureUp();
  const r = await api('/api/generate', { ws: workspace, prompt, count, template_id, style: caption_style });
  if (r.error) throw new Error(r.error);
  const j = await waitJob(r.job_id);
  if (j.status === 'running') return J({ status: 'running', job_id: r.job_id, note: 'Poll with check_job.' });
  if (j.status === 'failed') throw new Error('generation failed: ' + (j.err || 'unknown'));
  return J(absFiles(j.result));
});

server.registerTool('edit_meme', {
  title: 'Edit a meme',
  description: 'Edit an existing generated meme by instruction (e.g. "make it more savage"). Pass the artifact object returned by generate_meme (one element of memes[]).',
  inputSchema: {
    instruction: z.string(),
    artifact: z.record(z.string(), z.any()).describe('A memes[] entry from a previous generate_meme result'),
    workspace: z.string().optional(),
  },
}, async ({ instruction, artifact, workspace = 'default' }) => {
  await ensureUp();
  const r = await api('/api/edit', { ws: workspace, instruction, artifact });
  if (r.error) throw new Error(r.error);
  const j = await waitJob(r.job_id);
  if (j.status === 'running') return J({ status: 'running', job_id: r.job_id });
  if (j.status === 'failed') throw new Error('edit failed: ' + (j.err || 'unknown'));
  return J(absFiles(j.result));
});

server.registerTool('list_templates', {
  title: 'List meme templates',
  description: 'Search the local template library (name/description/tags). Returns id, name, description, tags, box semantics.',
  inputSchema: { query: z.string().optional().describe('Search text'), limit: z.number().max(50).optional() },
}, async ({ query = '', limit = 20 }) => {
  await ensureUp();
  const r = await api('/api/templates?type=image&tab=classics&q=' + encodeURIComponent(query));
  return J({ total: r.total, templates: (r.items || []).slice(0, limit).map((t) => ({ id: t.id, name: t.name, description: t.description, tags: t.tags, box_count: t.box_count, box_semantics: t.box_semantics })) });
});

server.registerTool('get_trending', {
  title: 'Get trending meme formats',
  description: 'Current trend-scout feed: hot formats with heat, why-trending, and brand angles. Run run_trend_scout first if stale.',
  inputSchema: {},
}, async () => {
  await ensureUp();
  const t = await api('/api/trending');
  return J({ updated: t.updated, items: (t.items || []).map(({ preview, ...rest }) => rest) });
});

server.registerTool('run_trend_scout', {
  title: 'Refresh the trend feed',
  description: 'Runs the trend scout (Claude + web sweep, takes 2-6 min). Returns a job id — poll with check_job.',
  inputSchema: {},
}, async () => {
  await ensureUp();
  const r = await api('/api/trend-scout/run', {});
  return J({ status: 'running', job_id: r.job_id, note: 'Takes 2-6 minutes. Poll with check_job.' });
});

server.registerTool('check_job', {
  title: 'Check a background job',
  description: 'Poll a job id returned by generate_meme / edit_meme / run_trend_scout.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  await ensureUp();
  const j = await api('/api/jobs/' + job_id);
  return J(j.status === 'done' ? { status: 'done', result: absFiles(j.result) } : j);
});

(async () => { await server.connect(new StdioServerTransport()); })();
