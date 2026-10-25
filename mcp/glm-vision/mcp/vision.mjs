// kimi-eyes vision core — shared by the MCP server and the setup wizard.
// Zero-dependency. Node 18+ (native fetch, AbortSignal.timeout).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DB_PATH = path.join(__dirname, 'models-db.json');

// Single source of truth for the version: package.json.
// Shared by the MCP server (serverInfo.version) and any consumer of this module.
function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const VERSION = readPackageVersion();

export const EXT_MEDIA = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export const DEFAULT_PROMPT = 'Describe this image in detail.';

// A minimal 1x1 PNG used for setup verification.
export const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Resolution order: environment variables (VISION_*) > config.json.
// protocol resolves to 'openai' by default when nothing is set.
export function getConfig(env = process.env) {
  // 配置独立放在用户目录 ~/kimi-eyes/config.json（不依赖 .kimi-code 插件目录），
  // KimiCode / Claude Code / Codex 三工具共用同一份；可用 KIMI_EYES_HOME 覆盖。
  const home = env.KIMI_EYES_HOME || path.join(os.homedir(), 'kimi-eyes');
  const cfgPath = path.join(home, 'config.json');
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    // no config file yet — fine
  }
  const envProtocol = (env.VISION_API_PROTOCOL || '').toLowerCase();
  const protocol =
    envProtocol === 'openai' || envProtocol === 'anthropic'
      ? envProtocol
      : file.protocol || 'openai';
  return {
    configPath: cfgPath,
    protocol,
    apiKey: env.VISION_API_KEY || file.apiKey || '',
    baseUrl: env.VISION_API_URL || file.baseUrl || '',
    model: env.VISION_MODEL || file.model || '',
    mainModel: env.VISION_MAIN_MODEL || file.mainModel || '',
  };
}

export function checkConfig(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('VISION_API_KEY');
  if (!cfg.baseUrl) missing.push('VISION_API_URL');
  if (!cfg.model) missing.push('VISION_MODEL');
  return missing;
}

export function requireConfigured(cfg) {
  const missing = checkConfig(cfg);
  if (missing.length > 0) {
    throw new Error(
      `Vision API is not configured. Missing: ${missing.join(', ')}. ` +
        `Run "node setup.mjs" in the kimi-eyes plugin directory (or set the environment variables).`
    );
  }
}

// ---------------------------------------------------------------------------
// Models.dev capability database (see scripts/sync-models.mjs)
// ---------------------------------------------------------------------------

let modelsDbCache = null; // null = not loaded yet, undefined = unavailable

/** Load the slimmed models.dev database; returns null if unavailable. */
export function loadModelsDb() {
  if (modelsDbCache !== null) return modelsDbCache;
  try {
    modelsDbCache = JSON.parse(fs.readFileSync(MODELS_DB_PATH, 'utf8'));
  } catch {
    modelsDbCache = undefined;
  }
  return modelsDbCache;
}

/**
 * Look up whether a model name supports image input, using the models.dev cache.
 * Matching: exact id → provider/id suffix → case-insensitive display name.
 * @returns {{known: boolean, image: boolean}}
 */
export function lookupModelCapability(modelName) {
  const db = loadModelsDb();
  if (!db) return { known: false, image: false };
  const n = String(modelName || '').trim();
  if (!n) return { known: false, image: false };
  if (db[n]) return { known: true, image: !!db[n].image };
  const lower = n.toLowerCase();
  for (const [id, m] of Object.entries(db)) {
    if (id.toLowerCase().endsWith(`/${lower}`)) {
      return { known: true, image: !!m.image };
    }
    if (typeof m.name === 'string' && m.name.toLowerCase() === lower) {
      return { known: true, image: !!m.image };
    }
  }
  return { known: false, image: false };
}

/** Text tag used by the setup wizard: exact capability when known, keyword hint otherwise. */
export function modelCapabilityTag(modelName, visionHintRe) {
  const cap = lookupModelCapability(modelName);
  if (cap.known) return cap.image ? '✓视觉' : '文本';
  return visionHintRe && visionHintRe.test(modelName) ? '★疑似' : '';
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function openaiEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export function anthropicEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/v1\/messages$/i.test(b)) return b;
  if (/\/v\d+$/i.test(b)) return `${b}/messages`;
  return `${b}/v1/messages`;
}

export function modelsEndpoint(baseUrl, protocol) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  // 用户可能把完整 chat/completions 端点当 BaseUrl 填（与 openaiEndpoint 处理保持一致）
  if (/\/chat\/completions$/i.test(b)) b = b.replace(/\/chat\/completions$/i, '');
  if (/\/v\d+$/i.test(b)) return `${b}/models`;
  return `${b}/v1/models`;
}

// ---------------------------------------------------------------------------
// Vision API calls
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = Number(process.env.VISION_FETCH_TIMEOUT_MS) || 60000;
const MAX_TOKENS = Number(process.env.VISION_MAX_TOKENS) || 1024;

/**
 * Call the user-configured VLM with a base64 image.
 * @param {{imageBase64:string, mediaType:string, prompt?:string}} input
 * @param {{protocol:string, apiKey:string, baseUrl:string, model:string}} cfg
 * @returns {Promise<string>} text description
 */
export async function callVLM({ imageBase64, mediaType, prompt }, cfg) {
  requireConfigured(cfg);
  if (cfg.protocol === 'anthropic') {
    return callAnthropic(imageBase64, mediaType, prompt, cfg);
  }
  return callOpenAI(imageBase64, mediaType, prompt, cfg);
}

async function callOpenAI(imageBase64, mediaType, prompt, cfg) {
  const endpoint = openaiEndpoint(cfg.baseUrl);
  const body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || DEFAULT_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
        ],
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Vision API HTTP ${res.status}: ${(await safeText(res)).slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  throw new Error(`Unexpected response from vision API: ${JSON.stringify(data).slice(0, 300)}`);
}

async function callAnthropic(imageBase64, mediaType, prompt, cfg) {
  const endpoint = anthropicEndpoint(cfg.baseUrl);
  const body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt || DEFAULT_PROMPT },
        ],
      },
    ],
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Vision API HTTP ${res.status}: ${(await safeText(res)).slice(0, 300)}`);
  }
  const data = await res.json();
  const texts = (Array.isArray(data?.content) ? data.content : [])
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
  if (texts) return texts;
  throw new Error(`Unexpected response from vision API: ${JSON.stringify(data).slice(0, 300)}`);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '(could not read response body)';
  }
}

// ---------------------------------------------------------------------------
// Image sniffing
// ---------------------------------------------------------------------------

/**
 * Validate that a file is a supported image and return base64 + media type.
 * @returns {{imageBase64:string, mediaType:string}|null}
 */
export function sniffImage(absPath) {
  const ext = path.extname(absPath).toLowerCase().replace('.', '');
  if (!EXT_MEDIA[ext]) return null;
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  const ascii4 = buf.toString('ascii', 0, 4);
  let ok = false;
  if (ext === 'png') ok = buf.subarray(0, 8).toString('hex').startsWith('89504e47');
  else if (ext === 'jpg' || ext === 'jpeg') ok = buf.subarray(0, 3).toString('hex') === 'ffd8ff';
  else if (ext === 'gif') ok = ascii4 === 'GIF8';
  else if (ext === 'bmp') ok = ascii4 === 'BM';
  else if (ext === 'webp') {
    ok = buf.length > 12 && ascii4 === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  }
  if (!ok) return null;
  return { imageBase64: buf.toString('base64'), mediaType: EXT_MEDIA[ext] };
}

// ---------------------------------------------------------------------------
// Clipboard capture
// ---------------------------------------------------------------------------

/**
 * Grab the image currently in the system clipboard and save it to a temp PNG.
 * @returns {string} path to the temp PNG file
 */
export function clipboardImageToTemp() {
  const out = path.join(
    os.tmpdir(),
    `kimi-eyes-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$img = [System.Windows.Forms.Clipboard]::GetImage();',
      "if ($img -eq $null) { Write-Error 'No image in clipboard'; exit 1 };",
      `$img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join(' ');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'pipe',
      timeout: 20000,
    });
  } else if (process.platform === 'darwin') {
    try {
      execFileSync('pngpaste', [out], { stdio: 'pipe', timeout: 20000 });
    } catch (e) {
      throw new Error('Clipboard capture failed. Install "pngpaste" (brew install pngpaste). ' + e.message);
    }
  } else {
    try {
      const png = execFileSync('wl-paste', ['-t', 'image/png', '--no-newline'], {
        stdio: 'pipe',
        timeout: 15000,
      });
      fs.writeFileSync(out, png);
    } catch (e1) {
      try {
        const png = execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
          stdio: 'pipe',
          timeout: 15000,
        });
        fs.writeFileSync(out, png);
      } catch (e2) {
        throw new Error(
          'Clipboard capture failed. Need "wl-paste" (Wayland) or "xclip" (X11). ' +
            `${e1.message}; ${e2.message}`
        );
      }
    }
  }
  return out;
}
