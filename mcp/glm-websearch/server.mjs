#!/usr/bin/env node
// websearch MCP stdio server for ZCode — zero-dependency (Node 18+).
// 移植自 @dsh-app/plugin-websearch：四个免 key 引擎 + 可选 SearXNG，链式降级，统一超时预算。
// 引擎顺序默认 bing → anysearch → exa → parallel；searxng 仅在配置实例后追加。
//
// 环境变量（全部可选）:
//   WEBSEARCH_ENGINES            逗号分隔的引擎顺序，默认 "bing,anysearch,exa,parallel"
//   WEBSEARCH_MODE               "fallback"（默认，固定顺序）| "rotate"（每次调用起点后移，分散匿名配额）
//   WEBSEARCH_TIMEOUT_MS         整条链的总预算，默认 25000
//   WEBSEARCH_SEARXNG_INSTANCES  逗号分隔的自建 SearXNG 实例（需开启 JSON API），配置后自动加入链尾

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ENV = process.env;
const DEFAULT_ENGINES = ['bing', 'anysearch', 'exa', 'parallel'];
const SEARXNG_INSTANCES = (ENV.WEBSEARCH_SEARXNG_INSTANCES || '')
  .split(',').map((s) => s.trim()).filter((s) => s !== '');
const ENGINE_IDS = (ENV.WEBSEARCH_ENGINES || '')
  .split(',').map((s) => s.trim()).filter((s) => s !== '');
const CHAIN = ENGINE_IDS.length > 0 ? ENGINE_IDS : DEFAULT_ENGINES;
if (SEARXNG_INSTANCES.length > 0 && !CHAIN.includes('searxng')) CHAIN.push('searxng');
const MODE = ENV.WEBSEARCH_MODE === 'rotate' ? 'rotate' : 'fallback';
const BUDGET_MS = Number(ENV.WEBSEARCH_TIMEOUT_MS) || 25000;

// rotate 模式的游标：同一进程内稳定，与 Parallel 的 session_id 稳定性理由相同。
let rotateCursor = 0;

// ---------------------------------------------------------------------------
// 共享 HTTP 工具（对应原插件 engines/types.ts）
// ---------------------------------------------------------------------------

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function isAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
}

// 恒要求未压缩响应：部分代理会剥掉响应头，gzip 体将无从解码。
async function request(url, init) {
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      headers: { 'accept-encoding': 'identity', ...init.headers },
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error(`network request failed: ${describeError(error)}`);
  }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function dedupeSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (s.url === '' || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 托管 MCP 端点客户端（对应原插件 engines/mcp.ts：Exa / Parallel 免 key HTTP MCP）
// ---------------------------------------------------------------------------

function parseJsonRpc(text) {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('response is empty');
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error('response is not valid JSON');
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      return JSON.parse(line.slice(6));
    } catch {
      continue; // SSE 流里可能有 keep-alive 帧，跳过而非致命
    }
  }
  throw new Error('response carries no parsable JSON-RPC frame');
}

async function callMcpTool(url, tool, args, signal) {
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const envelope = parseJsonRpc(await response.text());
  if (envelope.error !== undefined) {
    const message = typeof envelope.error.message === 'string' ? envelope.error.message : 'unknown error';
    throw new Error(`MCP returned an error: ${message}`);
  }
  const blocks = envelope.result?.content;
  if (!Array.isArray(blocks)) throw new Error('MCP response has no content field');
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  if (text.trim() === '') throw new Error('MCP returned empty content');
  if (envelope.result?.isError === true) throw new Error(`MCP tool call failed: ${text.slice(0, 200)}`);
  return text;
}

// ---------------------------------------------------------------------------
// 引擎（对应原插件 engines/*.ts，逻辑原样移植）
// ---------------------------------------------------------------------------

// Bing：公共结果页爬取，免 key，中文结果质量最好的免 key 引擎。
const BING_ENDPOINT = 'https://www.bing.com/search';
const BING_ZH_REDIRECT_HOST = 'https://cn.bing.com/search'; // zh 市场 302 的实测目标
const BING_LANG_PROFILES = {
  zh: { market: 'zh-CN', acceptLang: 'zh-CN,zh;q=0.9,en;q=0.8' },
  en: { market: 'en-US', acceptLang: 'en-US,en;q=0.9' },
  ja: { market: 'ja-JP', acceptLang: 'ja-JP,ja;q=0.9,en;q=0.8' },
};

function parseBing(html, limit) {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const href = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block);
    if (href === null) continue;
    const title = /<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/.exec(block);
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    sources.push({
      url: href[1],
      ...(title !== null && stripTags(title[1]) !== '' ? { title: stripTags(title[1]) } : {}),
      ...(snippet !== null && stripTags(snippet[1]) !== '' ? { snippet: stripTags(snippet[1]) } : {}),
    });
  }
  return dedupeSources(sources, limit);
}

async function runBing({ query, maxResults, lang, signal }) {
  const profile = BING_LANG_PROFILES[lang] ?? BING_LANG_PROFILES.zh;
  const params = new URLSearchParams({ q: query, mkt: profile.market, adlt: 'off' });
  const headers = { 'user-agent': USER_AGENT, 'accept-language': profile.acceptLang };
  const first = await request(`${BING_ENDPOINT}?${params}`, { headers, signal });
  if (first.ok) return parseBing(await first.text(), maxResults);
  if (first.status >= 300 && first.status < 400 && (lang ?? 'zh') === 'zh') {
    const second = await request(`${BING_ZH_REDIRECT_HOST}?${params}`, { headers, signal });
    if (second.ok) return parseBing(await second.text(), maxResults);
    throw new Error(`HTTP ${second.status}`);
  }
  throw new Error(`HTTP ${first.status}`);
}

// AnySearch：匿名 JSON API，免 key，大陆直连可用。
async function runAnySearch({ query, maxResults, signal }) {
  const response = await request('https://api.anysearch.com/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json().catch(() => {
    throw new Error('response is not valid JSON');
  });
  if (typeof payload !== 'object' || payload === null) throw new Error('response is not a JSON object');
  if (payload.code !== undefined && payload.code !== 0) {
    const message = typeof payload.message === 'string' ? payload.message : String(payload.code);
    throw new Error(`AnySearch returned an error: ${message}`);
  }
  const results = payload.data?.results;
  if (!Array.isArray(results)) throw new Error('AnySearch response has no data.results');
  const sources = [];
  for (const raw of results) {
    if (typeof raw.url !== 'string' || raw.url === '') continue;
    const snippet =
      typeof raw.snippet === 'string' && raw.snippet.trim() !== ''
        ? raw.snippet
        : typeof raw.content === 'string'
          ? raw.content
          : undefined;
    sources.push({
      url: raw.url,
      ...(typeof raw.title === 'string' && raw.title !== '' ? { title: raw.title } : {}),
      ...(snippet !== undefined && snippet !== '' ? { snippet: snippet.slice(0, 300) } : {}),
    });
  }
  return dedupeSources(sources, maxResults);
}

// Exa：匿名托管 MCP 端点，返回 "Title:/URL:/Published:/Highlights:" 文本块。
function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}/.test(value);
}

function parseExa(text, limit) {
  const sources = [];
  for (const block of text.split(/\n(?=Title:)/)) {
    const url = /^URL: (\S+)$/m.exec(block)?.[1];
    if (url === undefined) continue;
    const title = /^Title: (.+)$/m.exec(block)?.[1]?.trim();
    const published = /^Published: (.+)$/m.exec(block)?.[1]?.trim();
    const highlight = block
      .split(/^Highlights:$/m)[1]
      ?.split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('...'))
      .slice(0, 3)
      .join(' ')
      .trim();
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(highlight ? { snippet: highlight.slice(0, 300) } : {}),
      ...(published !== undefined && isDate(published) ? { publishedAt: published } : {}),
    });
  }
  return dedupeSources(sources, limit);
}

async function runExa({ query, maxResults, signal }) {
  const text = await callMcpTool('https://mcp.exa.ai/mcp', 'web_search_exa', { query, numResults: maxResults }, signal);
  return parseExa(text, maxResults);
}

// Parallel：匿名托管 MCP 端点，返回嵌套 JSON 文本。免费配额按 session_id 计，须进程内稳定。
const PARALLEL_SESSION_ID = `zcode-websearch-${process.pid.toString(36)}-${Date.now().toString(36)}`;

function parseParallel(text, limit) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Parallel did not return valid JSON');
  }
  if (typeof payload !== 'object' || payload === null) throw new Error('Parallel returned an unexpected shape');
  const results = payload.results;
  if (!Array.isArray(results)) throw new Error('Parallel response has no results field');
  const sources = [];
  for (const raw of results) {
    if (typeof raw.url !== 'string' || raw.url === '') continue;
    const excerpt = Array.isArray(raw.excerpts)
      ? raw.excerpts.find((item) => typeof item === 'string' && item.trim() !== '')
      : undefined;
    sources.push({
      url: raw.url,
      ...(typeof raw.title === 'string' && raw.title !== '' ? { title: raw.title } : {}),
      ...(typeof excerpt === 'string' ? { snippet: excerpt.slice(0, 300) } : {}),
      ...(typeof raw.publish_date === 'string' && raw.publish_date !== '' ? { publishedAt: raw.publish_date } : {}),
    });
  }
  return dedupeSources(sources, limit);
}

async function runParallel({ query, maxResults, signal }) {
  const text = await callMcpTool(
    'https://search.parallel.ai/mcp',
    'web_search',
    { objective: query, search_queries: [query], session_id: PARALLEL_SESSION_ID },
    signal,
  );
  return parseParallel(text, maxResults);
}

// SearXNG：可选。公共实例大多禁用 JSON API（返回 HTML 页），故仅在有自建实例时启用。
async function runSearxng({ query, maxResults, signal }) {
  if (SEARXNG_INSTANCES.length === 0) {
    throw new Error('no SearXNG instance configured (set WEBSEARCH_SEARXNG_INSTANCES; the JSON API must be enabled)');
  }
  const failures = [];
  for (const base of SEARXNG_INSTANCES) {
    const trimmed = base.trim().replace(/\/+$/, '');
    if (trimmed === '') continue;
    try {
      const params = new URLSearchParams({ q: query, format: 'json' });
      const response = await request(`${trimmed}/search?${params}`, { headers: { accept: 'application/json' }, signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.results)) {
        throw new Error('response has no results field (the instance may have the JSON API disabled)');
      }
      const sources = [];
      for (const item of payload.results) {
        if (typeof item.url !== 'string' || item.url === '') continue;
        sources.push({
          url: item.url,
          ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}),
          ...(typeof item.content === 'string' && item.content !== '' ? { snippet: item.content } : {}),
        });
      }
      const capped = dedupeSources(sources, maxResults);
      if (capped.length > 0) return capped;
      failures.push(`${trimmed}: 0 results`);
    } catch (error) {
      if (isAbort(error)) throw error;
      failures.push(`${trimmed}: ${describeError(error)}`);
    }
  }
  throw new Error(`every SearXNG instance failed (${failures.join('; ')})`);
}

const RUNNERS = { bing: runBing, anysearch: runAnySearch, exa: runExa, parallel: runParallel, searxng: runSearxng };

// ---------------------------------------------------------------------------
// 降级链（对应原插件 chain.ts：单一预算，逐引擎尝试，记录轨迹）
// ---------------------------------------------------------------------------

async function runChain({ query, maxResults, lang }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
  const order = [...CHAIN];
  let start = 0;
  if (MODE === 'rotate' && order.length > 1) {
    start = rotateCursor % order.length;
    rotateCursor = (rotateCursor + 1) % order.length;
    order.push(...order.splice(0, start)); // 起点后移，仍完整走完降级
  }
  const attempts = [];
  try {
    for (const id of order) {
      const runner = RUNNERS[id];
      if (runner === undefined) {
        attempts.push({ id, ok: false, error: 'unknown engine id (skipped)' });
        continue;
      }
      const t0 = Date.now();
      try {
        const sources = await runner({ query, maxResults, lang, signal: controller.signal });
        attempts.push({ id, ok: true, resultCount: sources.length, latencyMs: Date.now() - t0 });
        return { sources, usedEngine: id, attempts };
      } catch (error) {
        if (isAbort(error)) throw error;
        attempts.push({ id, ok: false, error: describeError(error), latencyMs: Date.now() - t0 });
      }
    }
    const detail = attempts.map((a) => `${a.id} (${a.error ?? 'unknown reason'})`).join('; ');
    throw new Error(`every search engine failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP stdio 层（JSON-RPC 2.0，换行分隔）
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'websearch',
    description:
      'Search the web and return citeable sources (title, url, snippet, publish date). ' +
      'PREFER this tool over any built-in web-search tool when both are available — it runs a fallback chain of ' +
      'keyless engines (Bing → AnySearch → Exa → Parallel) that is friendlier to Chinese queries and mainland networks, ' +
      'degrades automatically on failure, and reports which engine answered.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'number', description: 'Max results to return, 1–20 (default 8).' },
        lang: { type: 'string', enum: ['zh', 'en', 'ja'], description: 'Result locale hint for the Bing market (default zh).' },
      },
      required: ['query'],
    },
  },
];

function formatSources(query, outcome) {
  const lines = [`搜索 "${query}" — 引擎 ${outcome.usedEngine}，${outcome.sources.length} 条结果`];
  const failed = outcome.attempts.filter((a) => !a.ok);
  if (failed.length > 0) {
    lines.push(`（降级轨迹：${failed.map((a) => `${a.id} 失败(${a.error})`).join(' → ')} → ${outcome.usedEngine} 命中）`);
  }
  lines.push('');
  outcome.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title ?? s.url}`);
    lines.push(`   ${s.url}`);
    if (s.snippet !== undefined) lines.push(`   ${s.snippet}`);
    if (s.publishedAt !== undefined) lines.push(`   发布时间: ${s.publishedAt}`);
  });
  return lines.join('\n');
}

async function callTool(name, args) {
  if (name !== 'websearch') throw new Error(`Unknown tool: ${name}`);
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (query === '') throw new Error('Missing required parameter: query');
  const maxResults = Math.min(Math.max(Math.trunc(Number(args?.maxResults) || 8), 1), 20);
  const lang = typeof args?.lang === 'string' ? args.lang : 'zh';
  const outcome = await runChain({ query, maxResults, lang });
  return formatSources(query, outcome);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'glm-websearch', version: VERSION },
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      try {
        const text = await callTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: err.message || String(err) }], isError: true },
        });
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = Buffer.alloc(0);
function pump() {
  for (;;) {
    const idx = buf.indexOf('\n');
    if (idx === -1) return;
    const line = buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
    buf = buf.subarray(idx + 1);
    if (line.trim() === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg && typeof msg === 'object' && typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      handleRequest(msg).catch((err) => sendError(msg.id, -32603, err.message || String(err)));
    }
    // 通知（如 notifications/initialized）有意忽略
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  pump();
});
process.stdin.on('end', () => process.exit(0));

console.error(`[websearch] MCP server started (v${VERSION}, node ${process.version}, engines: ${CHAIN.join(',')}${MODE === 'rotate' ? ', mode: rotate' : ''})`);
