#!/usr/bin/env node
/**
 * codegraph-mcp — a standalone MCP stdio server for the code knowledge graph.
 *
 * This is a PORT of the DSH plugin `plugin-codegraph`. The parsing, indexing and
 * query engine under `core/` is the plugin's own host-independent code, copied
 * VERBATIM (it is plain TypeScript that Node 22 strips at load time); this file
 * replaces only the three DSH-specific pieces: the tool registration, the
 * settings routes and the system-prompt injection.
 *
 * What it does. Each project gets its own SQLite graph (one file under `data/`),
 * built by tree-sitter from the project's source files: symbols, call/import/
 * heritage/type-reference edges and the documents that name each symbol. Five
 * MCP tools work on it — find, impact, context and overview read it; cleanup
 * deletes graphs nobody has used for a while.
 *
 * The one rule carried over from the plugin and not to be dropped: EVERY answer
 * states how fresh the graph is. A graph that answers from a snapshot two hours
 * old without saying so is worse than one that refuses, because the model cannot
 * tell "no callers" from "we did not look".
 *
 * Index-on-demand. The first query for a project runs a full pass and waits for
 * it, so the first answer is real. After that, a graph older than
 * `CODEGRAPH_RECHECK_MS` (default 30s) is re-verified before it answers: one git
 * HEAD comparison, then an incremental pass that picks up uncommitted edits.
 * Inside that window answers come straight from the graph, which is what keeps a
 * burst of calls at a few milliseconds instead of half a second each. A query that
 * arrives while a pass is running reports `indexing`; `stale` means the graph is
 * provably behind AND the rebuild failed.
 *
 * Environment:
 *   CODEGRAPH_DATA_DIR     override the graph directory (default: ./data beside this file)
 *   CODEGRAPH_RECHECK_MS   how old a graph may be before a call re-verifies it
 *                          (default 30000; 0 builds a graph on first touch only)
 *   CODEGRAPH_DATA_TTL_DAYS  delete graph files unused for this many days at
 *                          startup (default 7; 0 disables the startup sweep)
 *
 * @module codegraph-mcp
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fileNodeId, openGraph, readProjectMeta } from './core/store.ts'
import { gitHead, indexProject, isStale } from './core/indexer.ts'
import { parseFile } from './core/tree-sitter.ts'
import { LANGUAGES, bundledGrammarDir, grammarPath } from './core/languages.ts'
import {
  ambiguousCandidates,
  callsOf,
  documentsFor,
  fileOutline,
  findSymbols,
  formatSymbol,
  freshnessNote,
  importsOf,
  projectOverview,
  referencesTo,
  relatedTo,
  resolveSymbol,
  symbolsInFile,
} from './core/query.ts'
import { renderOverviewContext } from './core/prompt.ts'

const VERSION = '1.0.0'

/** How many rows one answer may carry before it reports truncation. */
const MAX_ROWS = 40

/** The furthest reverse walk `codegraph_impact(depth)` will go. */
const MAX_DEPTH = 4

/**
 * How old a graph may be before the next tool call re-verifies the working tree.
 *
 * Verification has two halves: `git rev-parse HEAD` (a checkout, a commit, a
 * branch switch) and an incremental pass (an uncommitted edit, and a directory
 * outside any repository, which has no HEAD at all). Both cost real time —
 * measured on this machine, spawning git is ~250ms, which would be most of every
 * answer's latency — so they run at most once per project per window, not once per
 * call. `current` therefore means "verified within the last RECHECK_MS", and every
 * answer prints the exact index time so the reader can see the age.
 *
 * 0 disables re-verification entirely (a graph is then built on first touch only).
 */
const RECHECK_MS = Number.isFinite(Number(process.env.CODEGRAPH_RECHECK_MS)) ? Number(process.env.CODEGRAPH_RECHECK_MS) : 30_000

/** Default keep-window for `codegraph_cleanup` and the startup sweep: one week. */
const DEFAULT_DATA_TTL_DAYS = 7

/** The largest keep-window either cleanup path accepts. */
const MAX_DATA_TTL_DAYS = 365

/**
 * The ONLY names cleanup may touch: one graph file, `<label>-<8 hex>.sqlite`.
 *
 * `graphFileFor` produces exactly this shape, and restricting to it is what keeps
 * the sweep from deleting a hand-made file that happens to sit in `data/`.
 */
const GRAPH_FILE_PATTERN = /^(.+)-[0-9a-f]{8}\.sqlite$/u

/** SQLite's Write-Ahead-Log companions, named `<db>-wal` and `<db>-shm`. */
const GRAPH_COMPANION_SUFFIXES = ['-wal', '-shm']

/** How many documents `codegraph_context` quotes a sentence from. */
const MAX_DOC_SNIPPETS = 6

/**
 * How many symbols of the same file `codegraph_context` names.
 *
 * The plugin names up to 40; on a 400-symbol file that is a directory dump that
 * buries the symbol being asked about. Twelve is enough to see the neighbours, and
 * `codegraph_context("<file path>")` is the call for the full outline.
 */
const SIBLING_ROWS = 12

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DATA_DIR = process.env.CODEGRAPH_DATA_DIR !== undefined && process.env.CODEGRAPH_DATA_DIR.trim() !== ''
  ? resolve(process.env.CODEGRAPH_DATA_DIR.trim())
  : join(HERE, 'data')
const GRAMMAR_PATHS = { bundledDir: bundledGrammarDir(), downloadDir: join(DATA_DIR, 'grammars') }
const RUNTIME_WASM = join(bundledGrammarDir(), 'web-tree-sitter.wasm')

/**
 * The largest single JSON-RPC message this server will buffer.
 *
 * `tools/call` arguments are small; the payload that can be large is a request the
 * client should never send. Without a cap, a line with no newline grows the buffer
 * until the process runs out of memory, which on a stdio server looks like a hang.
 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** One line on stderr. stdout carries JSON-RPC only. */
function log(message) {
  console.error(`[codegraph] ${message}`)
}

// ---------------------------------------------------------------------------
// Project registry: one open graph per project, plus its live index state
// ---------------------------------------------------------------------------

/**
 * Open graphs by absolute project root.
 *
 * A graph stays open for the server's lifetime: opening costs a schema check and
 * a WAL pragma, and every tool call needs it. A graph is a derived artifact, so a
 * failed open is repaired by `openGraph` itself (it recreates an unusable file).
 *
 * @type {Map<string, {
 *   root: string,
 *   graph: import('./core/store.ts').Graph,
 *   meta: import('./core/store.ts').ProjectMeta | undefined,
 *   indexing: Promise<unknown> | undefined,
 *   failure: string | undefined,
 *   justIndexedMs: number | undefined,
 * }>}
 */
const projects = new Map()

/**
 * Where one project's graph lives.
 *
 * The name is `<project basename>-<sha256(cwd)[0:8]>.sqlite`: readable at a
 * glance, and unique per directory without letting a project name collide with
 * another project of the same name. Derived from the cwd, never from a request
 * body — a caller-chosen path here would be an arbitrary file write.
 *
 * @param {string} root - absolute project root.
 * @returns {string} absolute path of the `.sqlite` file.
 */
function graphFileFor(root) {
  mkdirSync(DATA_DIR, { recursive: true })
  const key = createHash('sha256').update(root).digest('hex').slice(0, 8)
  const label = (basename(root) || 'project').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 40)
  return join(DATA_DIR, `${label}-${key}.sqlite`)
}

/**
 * The live state for one project, opening its graph on first use.
 *
 * @param {string} root - absolute project root.
 * @returns {ReturnType<typeof projectEntry>} the state object.
 */
function projectEntry(root) {
  const existing = projects.get(root)
  if (existing !== undefined) return existing
  const file = graphFileFor(root)
  let graph
  try {
    graph = openGraph(file)
  } catch (error) {
    // A graph directory that cannot be written is an environment problem, and the
    // message has to name the file: "attempt to write a readonly database" alone
    // cannot be acted on.
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot open the code graph for ${root} (file: ${file}): ${reason}`)
  }
  const entry = {
    root,
    graph,
    meta: readProjectMeta(graph.db),
    indexing: undefined,
    failure: undefined,
    justIndexedMs: undefined,
  }
  projects.set(root, entry)
  return entry
}

// ---------------------------------------------------------------------------
// Data cleanup: delete graph files nobody has used for a while
// ---------------------------------------------------------------------------

/**
 * A path key that compares equal regardless of Windows case.
 *
 * The skip-set only exists so cleanup cannot unlink a database this process has
 * open; a `Client-4bf0830c.sqlite` vs `client-4bf0830c.sqlite` mismatch on a
 * case-insensitive filesystem would defeat exactly that.
 *
 * @param {string} file - absolute path.
 * @returns {string} the comparison key.
 */
function pathKey(file) {
  const absolute = resolve(file)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** The graph files this process currently holds open. */
function openGraphFiles() {
  const open = new Set()
  for (const root of projects.keys()) open.add(pathKey(graphFileFor(root)))
  return open
}

/**
 * Byte size of one path, or 0 when it vanished between listing and stat.
 *
 * @param {string} file - absolute path.
 * @returns {number} size in bytes.
 */
function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Total size of everything under the data directory.
 *
 * Recursive on purpose: the answer "data/ is 60 MB" must include the grammars
 * directory too, or the number disagrees with `du` and looks like a bug. Only
 * `cleanupGraphs` is restricted to the top level; this read is not a delete.
 *
 * @param {string} dir - absolute directory.
 * @returns {number} total bytes, 0 when the directory does not exist.
 */
function dataDirSize(dir) {
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parent = typeof entry.parentPath === 'string' && entry.parentPath !== '' ? entry.parentPath : dir
    total += sizeOf(join(parent, entry.name))
  }
  return total
}

/**
 * Render a byte count the way the report reads ("12 B", "60.1 MB").
 *
 * @param {number} bytes - count.
 * @returns {string} human-readable size.
 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * One cleanup pass over the TOP LEVEL of `data/`.
 *
 * Safety rules, all of them deliberate:
 *   - `readdirSync(DATA_DIR)` without `recursive` and `dirent.isFile()`: no
 *     subdirectory is ever visited, and a symlink is not a file here.
 *   - only names matching `<label>-<8 hex>.sqlite` qualify, plus that exact
 *     file's `-wal`/`-shm` companions when they exist;
 *   - a graph open in THIS process is never a candidate (its mtime may look old
 *     while a session still answers from it);
 *   - a failed unlink (permission, a lock from another process) is logged and
 *     skipped; the pass continues with the next file;
 *   - the keep-window is the file's mtime, which `openGraph`'s writes refresh,
 *     so "unused" really means "not touched by a query or a rebuild".
 *
 * @param {number} ttlDays - keep graphs used within this many days (>= 1).
 * @param {boolean} dryRun - collect the candidates but touch no file.
 * @returns {{
 *   cutoff: number,
 *   scanned: number,
 *   stale: object[],
 *   kept: object[],
 *   skippedOpen: object[],
 *   failed: {name: string, reason: string}[],
 *   released: number,
 *   totalAfter: number,
 * }} the pass result; `released` counts only bytes actually unlinked.
 */
function cleanupGraphs(ttlDays, dryRun) {
  const cutoff = Date.now() - ttlDays * 86_400_000
  const open = openGraphFiles()
  const result = { cutoff, scanned: 0, stale: [], kept: [], skippedOpen: [], failed: [], released: 0, totalAfter: 0 }

  let dirents
  try {
    dirents = readdirSync(DATA_DIR, { withFileTypes: true })
  } catch {
    // A data directory that was never created holds nothing to clean.
    result.totalAfter = 0
    return result
  }

  const present = new Set(dirents.map(entry => entry.name))
  const ordered = [...dirents].sort((a, b) => a.name.localeCompare(b.name))
  for (const dirent of ordered) {
    if (!dirent.isFile()) continue
    if (GRAPH_FILE_PATTERN.exec(dirent.name) === null) continue
    result.scanned += 1

    const file = join(DATA_DIR, dirent.name)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }

    const companions = []
    for (const suffix of GRAPH_COMPANION_SUFFIXES) {
      const name = `${dirent.name}${suffix}`
      if (!present.has(name)) continue
      companions.push({ name, file: join(DATA_DIR, name), size: sizeOf(join(DATA_DIR, name)) })
    }
    const record = { name: dirent.name, size: stat.size, mtimeMs: stat.mtimeMs, companions, deleted: false }

    if (open.has(pathKey(file))) {
      result.skippedOpen.push(record)
      continue
    }
    if (stat.mtimeMs > cutoff) {
      result.kept.push(record)
      continue
    }

    if (dryRun) {
      result.stale.push(record)
      continue
    }

    // Companions first: while the main file exists alone the pair is merely
    // incomplete, whereas a lone -wal with no database is an orphan that no
    // later pass would ever associate with a name again.
    for (const companion of companions) {
      try {
        unlinkSync(companion.file)
        result.released += companion.size
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        result.failed.push({ name: companion.name, reason })
        log(`data cleanup: could not remove ${companion.name}: ${reason}`)
      }
    }
    try {
      unlinkSync(file)
      record.deleted = true
      result.released += record.size
      result.stale.push(record)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      result.failed.push({ name: dirent.name, reason })
      log(`data cleanup: could not remove ${dirent.name}: ${reason}`)
    }
  }

  result.totalAfter = dataDirSize(DATA_DIR)
  return result
}

/**
 * Clamp a requested keep-window into the supported range.
 *
 * A tool caller that passes 0 gets an ERROR rather than "delete everything":
 * 0 means "disabled" for the environment variable, and letting the same value
 * mean "no retention at all" in one place and "off" in another is how a typo
 * turns into a wipe.
 *
 * @param {unknown} requested - raw `ttl_days` argument.
 * @returns {number} an integer in [1, MAX_DATA_TTL_DAYS].
 */
function clampTtlDays(requested) {
  if (requested === undefined || requested === null || requested === '') return DEFAULT_DATA_TTL_DAYS
  const value = Number(requested)
  if (!Number.isFinite(value)) {
    throw new Error(`ttl_days must be an integer between 1 and ${String(MAX_DATA_TTL_DAYS)}, got ${JSON.stringify(requested)}`)
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_DATA_TTL_DAYS) {
    throw new Error(`ttl_days must be an integer between 1 and ${String(MAX_DATA_TTL_DAYS)}, got ${String(requested)}`)
  }
  return value
}

/** Read a boolean argument that a client may send as a real bool or a string. */
function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  return fallback
}

/**
 * The `codegraph_cleanup` answer: what was deleted (or would be), and the state
 * of `data/` afterwards.
 *
 * @param {number} ttlDays - keep-window in days.
 * @param {boolean} dryRun - report without deleting.
 * @returns {string} the report text.
 */
function cleanupReport(ttlDays, dryRun) {
  const result = cleanupGraphs(ttlDays, dryRun)
  const candidates = dryRun ? result.stale : result.stale.filter(record => record.deleted)
  const lines = []

  lines.push(`codegraph_cleanup ${dryRun ? 'DRY RUN — nothing was deleted (未删除)' : 'done'}`)
  lines.push(`data: ${DATA_DIR}`)
  lines.push(`ttl: ${String(ttlDays)} day(s) — a graph is stale when last used before ${new Date(result.cutoff).toISOString()} (mtime)`)
  lines.push(
    `graph files: ${String(result.scanned)} — ${dryRun ? 'would remove' : 'removed'} ${String(candidates.length)}, `
    + `kept ${String(result.kept.length)}, skipped (open) ${String(result.skippedOpen.length)}, failed ${String(result.failed.length)}`,
  )

  if (candidates.length === 0) {
    lines.push(dryRun ? 'nothing stale — no graph file is older than the ttl' : 'nothing stale — no graph file was old enough to remove')
  } else {
    lines.push(dryRun ? 'would remove:' : 'removed:')
    for (const record of candidates) {
      lines.push(`- ${record.name} — ${humanBytes(record.size)} — last used ${new Date(record.mtimeMs).toISOString()}`)
      for (const companion of record.companions) {
        lines.push(`  companion: ${companion.name} — ${humanBytes(companion.size)} — ${dryRun ? 'would be removed too' : 'removed'}`)
      }
    }
  }

  if (result.kept.length > 0) {
    lines.push('kept (within the ttl):')
    for (const record of result.kept) {
      lines.push(`- ${record.name} — ${humanBytes(record.size)} — last used ${new Date(record.mtimeMs).toISOString()}`)
    }
  }
  if (result.skippedOpen.length > 0) {
    lines.push('skipped (open in this process):')
    for (const record of result.skippedOpen) lines.push(`- ${record.name} — ${humanBytes(record.size)}`)
  }
  if (result.failed.length > 0) {
    lines.push('failed (left in place):')
    for (const failure of result.failed) lines.push(`- ${failure.name}: ${failure.reason}`)
  }

  lines.push(dryRun
    ? `released: 0 B — dry run, nothing was deleted (would release ${humanBytes(candidates.reduce((sum, record) => sum + record.size + record.companions.reduce((inner, companion) => inner + companion.size, 0), 0))})`
    : `released: ${humanBytes(result.released)}`)
  lines.push(`data/ total now: ${humanBytes(result.totalAfter)}`)
  return textOf(lines)
}

/**
 * The startup sweep, gated by `CODEGRAPH_DATA_TTL_DAYS`.
 *
 * Runs ONCE at boot (not on a timer): a user who wants to keep 90 days must not
 * lose a 30-day-old graph to a background pass that a different tool call
 * happened to trigger.
 */
function startupDataCleanup() {
  const raw = process.env.CODEGRAPH_DATA_TTL_DAYS
  let ttlDays = DEFAULT_DATA_TTL_DAYS
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw.trim())
    if (!Number.isFinite(value)) {
      log(`data cleanup: ignoring CODEGRAPH_DATA_TTL_DAYS=${JSON.stringify(raw)} (not a number); using ${String(DEFAULT_DATA_TTL_DAYS)}d`)
    } else if (value <= 0) {
      log(`data cleanup: disabled (CODEGRAPH_DATA_TTL_DAYS=${raw.trim()})`)
      return
    } else {
      ttlDays = Math.min(Math.floor(value), MAX_DATA_TTL_DAYS)
      if (Math.floor(value) !== ttlDays) log(`data cleanup: CODEGRAPH_DATA_TTL_DAYS=${raw.trim()} clamped to ${String(ttlDays)}d`)
    }
  }

  try {
    const result = cleanupGraphs(ttlDays, false)
    if (result.stale.length === 0) log(`data cleanup: nothing stale (ttl ${String(ttlDays)}d)`)
    else log(`data cleanup: removed ${String(result.stale.length)} stale graph(s) (ttl ${String(ttlDays)}d)`)
  } catch (error) {
    // A cleanup that cannot run must never block the server from serving.
    log(`data cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The one parse callback the indexer needs: resolved grammar → tree-sitter. */
async function parseOne(source, filePath, languageId) {
  const language = LANGUAGES.find(entry => entry.id === languageId)
  if (language === undefined) return emptyParsed('missing')
  const grammar = grammarPath(language, GRAMMAR_PATHS)
  // Not installed is NOT an empty file: the indexer records the reason and the
  // pass reports `missingLanguage`. A silent empty parse would look like "this
  // file declares nothing", which is exactly the wrong conclusion.
  if (grammar === undefined) return emptyParsed('missing')
  return await parseFile(grammar, RUNTIME_WASM, source, filePath, languageId)
}

/** The parse result for a file this server cannot parse at all. */
function emptyParsed(mode) {
  return {
    symbols: [],
    calls: [],
    imports: [],
    heritage: [],
    typeRefs: [],
    exports: [],
    hasError: false,
    unsupported: mode,
  }
}

/**
 * Start one incremental pass, or join the one already running for this project.
 *
 * Serialised per project rather than globally: two projects indexing at once is
 * two independent databases, but two passes on ONE database would race on the
 * same rows.
 *
 * @param {string} root - absolute project root.
 * @returns {Promise<import('./core/indexer.ts').IndexOutcome>} the finished pass.
 */
function startIndex(root) {
  const entry = projectEntry(root)
  if (entry.indexing !== undefined) return entry.indexing

  // The gate is the promise handed to concurrent callers. It is recorded BEFORE
  // the pass body runs, so a caller that arrives while the first file is being
  // parsed joins the same pass instead of starting a second one.
  let open
  let close
  const gate = new Promise((resolveGate, rejectGate) => {
    open = resolveGate
    close = rejectGate
  })
  // A gate nobody joins would be an unhandled rejection — and Node's default for
  // that is to KILL the process, which on a stdio server means the client loses
  // the server because one rebuild failed. Whoever awaits the pass still sees the
  // error; this handler only stops the process from dying over it.
  gate.catch(() => { /* observed by the caller that awaits the pass */ })
  entry.indexing = gate

  const started = Date.now()
  const pass = (async () => {
    try {
      const outcome = await indexProject(entry.graph, root, parseOne)
      entry.meta = readProjectMeta(entry.graph.db)
      entry.justIndexedMs = Date.now() - started
      log(
        `indexed ${root}: ${String(outcome.parsed)} parsed, ${String(outcome.skipped)} unchanged, `
        + `${String(outcome.removed)} removed in ${String(outcome.durationMs)}ms`
        + (outcome.truncated ? ' (TRUNCATED at the file budget)' : '')
        // The three skip counts are the reason an answer cannot call the graph
        // complete: they are logged on every pass, so a partial graph is visible in
        // the log as well as in every tool result.
        + (outcome.missingLanguage > 0 ? `, ${String(outcome.missingLanguage)} skipped (grammar not installed)` : '')
        + (outcome.noRules > 0 ? `, ${String(outcome.noRules)} skipped (no extraction rules)` : '')
        + (outcome.parseErrors > 0 ? `, ${String(outcome.parseErrors)} with parse errors` : ''),
      )
      for (const gap of coverageGaps(entry.graph, entry.meta)) log(`coverage gap for ${root}: ${gap}`)
      return outcome
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entry.failure = message
      log(`index failed for ${root}: ${message}`)
      throw error
    } finally {
      entry.indexing = undefined
    }
  })()
  // Settle the gate AFTER the pass, including its failure: a waiter must not hang
  // on a pass that already died.
  pass.then(
    (outcome) => { open(outcome) },
    (error) => { close(error) },
  )
  return pass
}

/**
 * How fresh this project's graph is, and the sentence that goes with it.
 *
 * Three reachable states, each with a distinct meaning:
 *   - `indexing` — a pass is running (or the last one failed and is waiting to be
 *     retried). The answer may be incomplete and says so.
 *   - `stale` — the graph is provably behind AND the rebuild could not complete,
 *     so the rows are older than the working tree and the answer says from when.
 *   - `current` — the tree was verified within `CODEGRAPH_RECHECK_MS` (or nothing
 *     has changed since that check), so the answer describes the code as it is.
 *
 * @param {string} root - absolute project root.
 * @returns {Promise<{ freshness: 'current' | 'stale' | 'indexing', note: string, meta?: object }>}
 */
async function prepare(root) {
  const entry = projectEntry(root)

  if (entry.indexing !== undefined) {
    return { freshness: 'indexing', note: sentence('indexing', entry.meta, entry.graph), meta: entry.meta }
  }

  if (entry.failure !== undefined) {
    // Reported ONCE, then the next call retries: a structural failure that
    // retried on every call would spin (an unreadable root never heals mid-session),
    // and one that never retried would dead-end the project forever.
    const reason = entry.failure
    entry.failure = undefined
    return {
      freshness: 'indexing',
      note: `The last index pass FAILED: ${reason}. This call does not start another pass; the next tool call for this project will retry it.`,
      meta: entry.meta,
    }
  }

  let meta = readProjectMeta(entry.graph.db)
  entry.meta = meta

  if (meta === undefined) {
    // First touch: a full pass now, so the first answer carries real rows. This
    // is the one place a tool call waits for an index; every later pass is
    // incremental and cheap.
    try {
      await startIndex(root)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        freshness: 'indexing',
        note: `The first index pass for this project FAILED: ${reason}. Nothing has been indexed yet, so this answer is empty by construction.`,
        meta: undefined,
      }
    }
    meta = readProjectMeta(entry.graph.db)
    entry.meta = meta
    const built = entry.justIndexedMs === undefined ? '' : ` This call built the graph in ${String(entry.justIndexedMs)}ms.`
    return { freshness: 'current', note: `${sentence('current', meta, entry.graph)}${built}`, meta }
  }

  // Not due: answer from the graph as it stands. The note carries the exact index
  // time, so "current" is a claim about a known moment rather than "now".
  if (RECHECK_MS <= 0 || Date.now() - meta.indexedAt <= RECHECK_MS) {
    return { freshness: 'current', note: sentence('current', meta, entry.graph), meta }
  }

  return await reverify(entry, meta)
}

/**
 * Verify a graph against the working tree, once per re-check window.
 *
 * HEAD first, because it is the only signal that a checkout happened without
 * touching the mtime of every file; then the incremental pass, because HEAD cannot
 * see an uncommitted edit. Both the comparison and the pass are skipped entirely
 * inside the window, which is what keeps a burst of tool calls cheap.
 *
 * @param {object} entry - the live project state.
 * @param {object} meta - the graph's metadata, read just before this call.
 * @returns {Promise<{ freshness: 'current' | 'stale', note: string, meta: object }>}
 */
async function reverify(entry, meta) {
  const head = await gitHead(entry.root)
  const moved = isStale(meta, head)
  try {
    await startIndex(entry.root)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      freshness: 'stale',
      note: moved
        ? `The graph is older than the working tree (the stored git HEAD no longer matches) and the rebuild FAILED: ${reason}. Results describe the state at ${new Date(meta.indexedAt).toISOString()}.`
        : `The working tree could not be re-checked (the incremental pass failed: ${reason}), so this answer describes the graph as of ${new Date(meta.indexedAt).toISOString()}.`,
      meta,
    }
  }
  const refreshed = readProjectMeta(entry.graph.db)
  entry.meta = refreshed
  const took = entry.justIndexedMs === undefined ? '' : ` in ${String(entry.justIndexedMs)}ms`
  return {
    freshness: 'current',
    note: `${sentence('current', refreshed, entry.graph)} This call ${moved ? 'rebuilt the graph because the git HEAD moved' : 're-checked the working tree with an incremental pass'}${took}.`,
    meta: refreshed,
  }
}

/**
 * The languages whose grammar this installation does NOT have.
 *
 * `grammarPath` answers undefined for a bundled grammar that has gone missing
 * (a broken install) and for every on-demand one (nothing downloads them here), so
 * the caller has to say which of the two it is: the fixes are different.
 *
 * @returns {{ id: string, label: string, wasm: string, dir: string, bundled: boolean }[]}
 */
function unavailableGrammars() {
  const unavailable = []
  for (const language of LANGUAGES) {
    if (grammarPath(language, GRAMMAR_PATHS) !== undefined) continue
    unavailable.push({
      id: language.id,
      label: language.label,
      wasm: `tree-sitter-${language.grammar}.wasm`,
      dir: language.bundled ? GRAMMAR_PATHS.bundledDir : GRAMMAR_PATHS.downloadDir,
      bundled: language.bundled,
    })
  }
  return unavailable
}

/**
 * Per-language file counts for the grammars this installation lacks.
 *
 * `meta.missingLanguage` is the indexer's COUNT; the `files` table knows each
 * skipped file's language, so the answer can name them. "1 file skipped" is not
 * actionable; "css 1 file — put tree-sitter-css.wasm under <dir>" is.
 *
 * @param {import('./core/store.ts').Graph} graph - the open graph.
 * @returns {{ lang: string, files: number, wasm: string, dir: string, bundled: boolean }[]}
 */
function missingGrammarFiles(graph) {
  const unavailable = unavailableGrammars()
  if (unavailable.length === 0) return []
  const placeholders = unavailable.map(() => '?').join(', ')
  const rows = graph.db.prepare(
    `SELECT lang, COUNT(*) AS n FROM files WHERE lang IN (${placeholders}) GROUP BY lang ORDER BY n DESC, lang`,
  ).all(...unavailable.map(language => language.id))
  const byId = new Map(unavailable.map(language => [language.id, language]))
  return rows.map((row) => {
    const language = byId.get(row.lang)
    return { lang: row.lang, files: row.n, wasm: language.wasm, dir: language.dir, bundled: language.bundled }
  })
}

/**
 * Everything the last pass could not cover, as sentences a reader can act on.
 *
 * The indexer persists these counts on purpose (`missingLanguage`, `noRules`,
 * `parseErrors` in `core/store.ts`) because a graph that covers 90% of a project
 * and says so is useful while one that silently covers 60% is not — and this is
 * the module that has to say it. Dropping them here was the defect this function
 * exists to prevent: a project with a `.css` file and no CSS grammar answered
 * "The graph matches the working tree" while that file contributed nothing.
 *
 * @param {import('./core/store.ts').Graph} graph - the open graph.
 * @param {object | undefined} meta - the project metadata from the last pass.
 * @returns {string[]} one sentence per gap; empty when the graph is complete.
 */
function coverageGaps(graph, meta) {
  if (meta === undefined || meta === null) return []
  const gaps = []
  if (meta.missingLanguage > 0) {
    const rows = missingGrammarFiles(graph)
    const detail = rows.length === 0
      ? `${String(meta.missingLanguage)} file(s)`
      : rows.map(row => `${row.lang} ${String(row.files)} file(s), needs ${row.wasm} in ${row.dir}`).join('; ')
    gaps.push(
      `${String(meta.missingLanguage)} file(s) were NOT indexed because their grammar is not installed `
      + `(${detail})`,
    )
  }
  if (meta.noRules > 0) {
    gaps.push(`${String(meta.noRules)} file(s) were NOT indexed because this build has no extraction rules for their grammar`)
  }
  if (meta.parseErrors > 0) {
    gaps.push(`${String(meta.parseErrors)} file(s) parsed with syntax errors, so their symbols are partial`)
  }
  return gaps
}

/**
 * The one-sentence explanation that accompanies every answer's freshness.
 *
 * Three branches, because "how old" and "how complete" are different questions and
 * conflating them is how a partial graph passes for a full one. `stale` is
 * rendered by the caller that failed to rebuild (it knows which pass failed and
 * why), but the branch is here so a future caller cannot fall through to
 * "being built right now".
 *
 * @param {'current' | 'stale' | 'indexing'} freshness - the state.
 * @param {object | undefined} meta - the project's stored metadata.
 * @param {import('./core/store.ts').Graph | undefined} graph - the graph the meta describes.
 * @returns {string} the sentence, never empty.
 */
function sentence(freshness, meta, graph) {
  const stats = meta === undefined || meta === null
    ? ''
    : `${String(meta.fileCount)} files / ${String(meta.symbolCount)} symbols / ${String(meta.edgeCount)} edges, `
      + `last indexed ${new Date(meta.indexedAt).toISOString()}`
      + (meta.head === '' ? ' (no git HEAD)' : ` at HEAD ${String(meta.head).slice(0, 7)}`)
  const derived = stats === '' ? '' : `; ${stats}`
  if (freshness === 'stale') {
    return `The graph is older than the working tree${derived} and has not been rebuilt, so these rows describe an earlier state.`
  }
  if (freshness === 'current') {
    // The plugin's own clause for a pass that could not cover everything.
    const passCaveat = meta === undefined || meta === null
      ? undefined
      : freshnessNote('current', meta.truncated, meta.removalSkipped)
    const gaps = graph === undefined ? [] : coverageGaps(graph, meta)
    if (gaps.length === 0) {
      return [`The graph matches the working tree${derived}.`, passCaveat].filter(Boolean).join(' ')
    }
    // Deliberately NOT "matches the working tree": the PASS is up to date, the
    // COVERAGE is not, and an absent symbol may be a gap rather than a fact.
    const head = `The graph is up to date${stats === '' ? '' : ` (${stats})`} but does NOT cover the whole project: `
      + `${gaps.join(' ')} Treat a missing symbol as possibly missing from the graph, not from the code.`
    return [head, passCaveat].filter(Boolean).join(' ')
  }
  return `The graph is being built right now${derived}; this answer may be incomplete — ask again in a moment.`
}

// ---------------------------------------------------------------------------
// Shared argument handling
// ---------------------------------------------------------------------------

/** Resolve the `project` argument (default: the server's own cwd). */
function resolveProject(value) {
  const target = typeof value === 'string' && value.trim() !== '' ? value.trim() : process.cwd()
  const absolute = resolve(target)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    throw new Error(`project path does not exist: ${absolute}`)
  }
  if (!stat.isDirectory()) throw new Error(`project path is not a directory: ${absolute}`)
  return absolute
}

/** Clamp a requested row limit into a sane range. */
function clampLimit(requested) {
  if (requested === undefined || requested === null || requested === '') return MAX_ROWS
  const value = Number(requested)
  if (!Number.isFinite(value)) return MAX_ROWS
  return Math.max(1, Math.min(Math.floor(value), 200))
}

/** Clamp a requested walk depth. */
function clampDepth(requested) {
  if (requested === undefined || requested === null || requested === '') return 1
  const value = Number(requested)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(Math.floor(value), MAX_DEPTH))
}

/**
 * The head of every answer: what was asked, and the honesty clause.
 *
 * @param {string} header - one-line statement of the question and its answer size.
 * @param {'current' | 'stale' | 'indexing'} freshness - the graph's state.
 * @param {string} note - the explanation.
 * @returns {string[]} lines.
 */
function envelope(header, freshness, note) {
  return [header, `freshness: ${freshness}`, `note: ${note}`]
}

/** Join rendered lines into one MCP text block. */
function textOf(lines) {
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tool: find
// ---------------------------------------------------------------------------

/**
 * `findSymbols` for a query that contains a LIKE wildcard.
 *
 * `core/query.ts` builds `name LIKE '%<query>%'` with no ESCAPE clause, so a `_`
 * in the query matches ANY character (`my_var` also matches `myXvar`) and a `%`
 * matches anything at all (`%` alone returns the whole table). The core is a
 * byte-identical copy, so the correction belongs here: this path tests the literal
 * substring with `instr()` instead, keeping the core's rules — an exact match wins,
 * then a case-insensitive substring, ordered by path/line, with the call-site
 * count — so the answer means the same thing as the un-wildcarded path.
 *
 * @param {import('./core/store.ts').Graph} graph - the open graph.
 * @param {string} query - the user's query, containing `%` or `_`.
 * @param {number} limit - how many symbols to return.
 * @returns {{ symbols: object[], truncated: boolean }}
 */
function findSymbolsLiteral(graph, query, limit) {
  const columns = 'SELECT id, name, kind, path, line, parent FROM symbols'
  const exact = graph.db.prepare(`${columns} WHERE name = ? ORDER BY path, line LIMIT ?`).all(query, limit + 1)
  const rows = exact.length > 0
    ? exact
    : graph.db.prepare(`${columns} WHERE instr(lower(name), lower(?)) > 0 ORDER BY path, line LIMIT ?`).all(query, limit + 1)
  const kept = rows.slice(0, limit)
  const counts = new Map()
  if (kept.length > 0) {
    const placeholders = kept.map(() => '?').join(', ')
    const counted = graph.db.prepare(
      `SELECT dst, COUNT(*) AS n FROM edges WHERE kind = 'references' AND dst IN (${placeholders}) GROUP BY dst`,
    ).all(...kept.map(row => row.id))
    for (const row of counted) counts.set(row.dst, row.n)
  }
  return {
    symbols: kept.map(row => ({ ...row, parent: row.parent ?? undefined, references: counts.get(row.id) ?? 0 })),
    truncated: rows.length > limit,
  }
}

async function toolFind(args) {
  const name = typeof args.name === 'string' && args.name.trim() !== ''
    ? args.name.trim()
    : typeof args.query === 'string' ? args.query.trim() : ''
  if (name === '') throw new Error('Missing required parameter: name (the symbol name to look for)')
  const root = resolveProject(args.project)
  const { freshness, note } = await prepare(root)
  const graph = projectEntry(root).graph
  const limit = clampLimit(args.limit)
  // A `%` or `_` in the query is literal text here, not a wildcard — identifiers
  // contain underscores, so this is the common case, not an edge case.
  const found = /[%_]/u.test(name) ? findSymbolsLiteral(graph, name, limit) : findSymbols(graph, name, limit)

  const lines = envelope(
    `codegraph_find "${name}" in ${root}: ${String(found.symbols.length)} match(es)${found.truncated ? ' (truncated at the limit)' : ''}`,
    freshness,
    note,
  )
  if (found.symbols.length === 0) {
    lines.push('No declaration matched. A shorter substring may match (the search falls back to a case-insensitive substring); if freshness is indexing or stale, ask again in a moment.')
  }
  for (const symbol of found.symbols) {
    const heavy = symbol.references > 20
      ? ` (large: \`codegraph_impact("${symbol.id}")\` is cheaper than searching)`
      : ''
    lines.push(`- ${formatSymbol(symbol)} — ${String(symbol.references)} call site(s)${heavy}`)
    lines.push(`  id: ${symbol.id}`)
  }
  return textOf(lines)
}

// ---------------------------------------------------------------------------
// Tool: impact
// ---------------------------------------------------------------------------

/**
 * The direct referrers of one symbol, with the SOURCE ids a multi-hop walk needs.
 *
 * `referencesTo` in the query layer deliberately answers display fields only;
 * the chain walk needs `src` to expand the next level, so this is its own read.
 *
 * @param {import('./core/store.ts').Graph} graph - the open graph.
 * @param {string} symbolId - the destination symbol.
 * @param {number} limit - rows per symbol.
 * @returns {{ rows: { src: string, line: number, name: string | null, path: string | null }[], truncated: boolean }}
 */
function inboundReferences(graph, symbolId, limit) {
  const rows = graph.db.prepare(
    `SELECT e.src AS src, e.line AS line, s.name AS name, s.path AS path
     FROM edges e LEFT JOIN symbols s ON s.id = e.src
     WHERE e.dst = ? AND e.kind = 'references'
     ORDER BY e.src, e.line LIMIT ?`,
  ).all(symbolId, limit + 1)
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

/**
 * The path behind an edge source, whether the source is a file or a symbol.
 *
 * The join in {@link inboundReferences} gives a path whenever the source is a
 * SYMBOL row. When it is not (a file-scope reference, or a symbol row a later pass
 * retired), the id itself is the only clue — and a symbol id is
 * `<path>#<kind>:<name>`, so stripping just the `file:` prefix would print
 * `src/index.ts#function:main` as a path. Splitting on the LAST `#` is what the
 * query layer does, and it is correct for a path that itself contains one.
 *
 * @param {string} src - the edge's source id.
 * @param {string | null} path - the joined symbol row's path, when there is one.
 * @returns {string} a project-relative path.
 */
function displayPathOf(src, path) {
  if (typeof path === 'string' && path !== '') return path
  if (src.startsWith('file:')) return src.slice('file:'.length)
  const hash = src.lastIndexOf('#')
  return hash > 0 ? src.slice(0, hash) : src
}

/**
 * Walk the reverse call chain, one level per depth step.
 *
 * @param {import('./core/store.ts').Graph} graph - the open graph.
 * @param {string} targetId - the symbol the question is about.
 * @param {number} depth - levels to walk (>= 1).
 * @param {number} limit - rows per symbol per level.
 * @returns {{ levels: { rows: { path: string, line: number, name: string | undefined, callee: string }[], truncated: boolean }[], truncated: boolean }}
 */
function reverseChain(graph, targetId, depth, limit) {
  const visited = new Set([targetId])
  let frontier = [targetId]
  const levels = []
  let truncated = false

  for (let level = 1; level <= depth; level += 1) {
    const rows = []
    const next = []
    let levelTruncated = false
    for (const calleeId of frontier) {
      const callee = readSymbolSafe(graph, calleeId)
      const calleeLabel = callee === undefined ? calleeId : formatSymbol(callee)
      const found = inboundReferences(graph, calleeId, limit)
      if (found.truncated) levelTruncated = true
      for (const row of found.rows) {
        rows.push({
          path: displayPathOf(row.src, row.path),
          line: row.line,
          name: row.name ?? undefined,
          callee: calleeLabel,
        })
        // A `file:` source is a file-scope reference: it has no symbol row, so
        // there is nothing to expand upward from it.
        if (row.src.startsWith('file:')) continue
        if (visited.has(row.src)) continue
        visited.add(row.src)
        next.push(row.src)
      }
    }
    levels.push({ rows, truncated: levelTruncated })
    if (levelTruncated) truncated = true
    // Bounded frontier: a hub called from 500 places would otherwise turn a
    // depth-3 walk into a full graph traversal.
    frontier = next.slice(0, 200)
    if (next.length > 200) truncated = true
    if (frontier.length === 0) break
  }
  return { levels, truncated }
}

/** `readSymbol`, tolerating a row that vanished between two passes. */
function readSymbolSafe(graph, id) {
  try {
    return resolveSymbol(graph, id)
  } catch {
    return undefined
  }
}

async function toolImpact(args) {
  const selector = typeof args.symbol === 'string' ? args.symbol.trim() : ''
  if (selector === '') throw new Error('Missing required parameter: symbol (an id from codegraph_find, or a name unique in this project)')
  const root = resolveProject(args.project)
  const { freshness, note } = await prepare(root)
  const graph = projectEntry(root).graph
  const limit = clampLimit(args.limit)
  const depth = clampDepth(args.depth)

  const target = resolveSymbol(graph, selector)
  if (target === undefined) {
    // An ambiguous name must not read like an absent one: "no unambiguous
    // symbol matched" made a symbol declared twice look like a symbol nobody
    // calls, and every edge to it is dropped as ambiguous by the indexer.
    const shared = ambiguousCandidates(graph, selector, 5)
    const lines = envelope(`codegraph_impact "${selector}": unresolved`, freshness, note)
    if (shared.total > 0) {
      lines.push(`That name is declared ${String(shared.total)} time(s), so no reference edges were built for it. Pass one of these ids:`)
      for (const candidate of shared.candidates) lines.push(`- ${formatSymbol(candidate)} (id: ${candidate.id})`)
      lines.push('An ambiguous name is not an absent one: this answer says nothing about how many callers exist. Verify with a text search before changing it.')
    } else {
      lines.push(`No symbol named that in ${root}. Use codegraph_find first to get a name or an id.`)
    }
    return textOf(lines)
  }

  if (depth > 1) {
    const chain = reverseChain(graph, target.id, depth, limit)
    const lines = envelope(
      `codegraph_impact "${selector}" — reverse call chain, depth ${String(depth)}: ${formatSymbol(target)}`,
      freshness,
      note,
    )
    let any = false
    chain.levels.forEach((level, index) => {
      const files = new Set(level.rows.map(row => row.path))
      lines.push(
        level.rows.length === 0
          ? `level ${String(index + 1)}: nothing calls this level`
          : `level ${String(index + 1)}: ${String(level.rows.length)} reference(s) across ${String(files.size)} file(s)${level.truncated ? ' (TRUNCATED)' : ''}:`,
      )
      for (const row of level.rows) {
        any = true
        const caller = row.name === undefined ? '' : ` (${row.name})`
        lines.push(`- ${row.path}:${String(row.line)}${caller} → calls ${row.callee}`)
      }
    })
    if (chain.truncated) lines.push(`TRUNCATED: at least one level was cut at ${String(limit)} rows per symbol, or the frontier was capped. Treat this chain as a sample.`)
    if (!any) lines.push('No direct callers found. That is NOT "safe to change": a call through an interface, a dynamic dispatch or a variable holds no name to resolve, so it leaves no edge. Verify with a text search.')
    return textOf(lines)
  }

  const referencing = referencesTo(graph, target.id, limit)
  const imports = importsOf(graph, target.path, limit)
  const related = relatedTo(graph, target.id, limit)
  const referrerFiles = new Set(referencing.rows.map(ref => ref.path)).size
  const lines = envelope(`codegraph_impact "${selector}": ${formatSymbol(target)}`, freshness, note)
  if (referencing.rows.length === 0) {
    lines.push('No direct callers found. That is NOT "safe to change": a call through an interface, a dynamic dispatch or a variable holds no name to resolve, so it leaves no edge. Verify with a text search.')
  } else if (referencing.truncated) {
    // The total leads when the list was cut: the sample is not the answer.
    lines.push(`referenced from ${String(referencing.total)} reference(s) — ${String(referencing.rows.length)} shown, across ${String(referrerFiles)} file(s):`)
    for (const ref of referencing.rows) lines.push(`- ${ref.path}:${String(ref.line)}${ref.name === undefined ? '' : ` (${ref.name})`}`)
    lines.push(`TRUNCATED: ${String(referencing.total - referencing.rows.length)} more reference(s) exist. This is a SAMPLE, not the complete list.`)
  } else {
    lines.push(`referenced from ${String(referencing.total)} reference(s) across ${String(referrerFiles)} file(s):`)
    for (const ref of referencing.rows) lines.push(`- ${ref.path}:${String(ref.line)}${ref.name === undefined ? '' : ` (${ref.name})`}`)
  }
  if (imports.rows.length > 0) {
    lines.push('its file imports:')
    for (const path of imports.rows) lines.push(`- ${path}`)
  }
  // Heritage and signature references are NOT callers, so they keep their own
  // headings: "who implements this interface" is a different question.
  for (const group of related.groups) {
    const heading = group.kind === 'type_refs'
      ? 'mentioned in a signature'
      : group.kind === 'extends' ? 'derived from this' : group.kind === 'exports' ? 'exported by its module' : 'implements this'
    lines.push(`${heading} (${String(group.rows.length)}):`)
    for (const row of group.rows) lines.push(`- ${row.path}:${String(row.line)}${row.name === undefined ? '' : ` (${row.name})`}`)
  }
  return textOf(lines)
}

// ---------------------------------------------------------------------------
// Tool: context
// ---------------------------------------------------------------------------

/**
 * The sentence (or line) a document names a symbol at.
 *
 * The graph stores `path:line` per mention, and the point of the `documents`
 * edge is "what is this for": a reader wants the sentence, not the file.
 */
function quoteMentions(root, rows, max) {
  const out = []
  const cache = new Map()
  for (const row of rows.slice(0, max)) {
    let lines = cache.get(row.path)
    if (lines === undefined) {
      try {
        lines = readFileSync(join(root, row.path), 'utf8').split(/\r?\n/u)
      } catch {
        lines = []
      }
      cache.set(row.path, lines)
    }
    const raw = (lines[row.line - 1] ?? '').trim().replace(/\s+/gu, ' ')
    out.push({ path: row.path, line: row.line, text: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw })
  }
  return out
}

async function toolContext(args) {
  const root = resolveProject(args.project)
  const { freshness, note } = await prepare(root)
  const graph = projectEntry(root).graph
  const limit = clampLimit(args.limit)
  const selector = typeof args.symbol === 'string' ? args.symbol.trim() : ''

  // No selector: the question no symbol name can answer ("what is this project").
  if (selector === '') return overviewText(root, freshness, note, graph)

  // A FILE PATH: the outline, which is the structural question text search
  // answers badly (a method definition never names its class).
  const asPath = selector.replace(/^\.\//u, '').replace(/\\/gu, '/')
  const asFile = fileOutline(graph, asPath, limit)
  if (asFile.symbols.length > 0) {
    const lines = envelope(
      `codegraph_context ${asFile.path} declares ${String(asFile.symbols.length)} symbol(s)${asFile.truncated ? ' (TRUNCATED — more exist)' : ''}`,
      freshness,
      note,
    )
    for (const entry of asFile.symbols) {
      const parent = entry.symbol.parent === undefined ? '' : `${entry.symbol.parent}.`
      const mark = entry.exported ? ' [exported]' : ''
      lines.push(`- ${entry.symbol.kind} ${parent}${entry.symbol.name}:${String(entry.symbol.line)} — ${String(entry.references)} call site(s)${mark}`)
    }
    if (asFile.starReExports.length > 0) {
      lines.push('re-exports these modules whole:')
      for (const path of asFile.starReExports) lines.push(`- ${path}`)
    }
    const imported = importsOf(graph, asFile.path, limit)
    if (imported.rows.length > 0) {
      lines.push('imports:')
      for (const path of imported.rows) lines.push(`- ${path}`)
    }
    lines.push('Pass any id above as `symbol` to expand it, or use `codegraph_impact` for what a change would touch.')
    return textOf(lines)
  }

  const symbol = resolveSymbol(graph, selector)
  if (symbol === undefined) {
    const shared = ambiguousCandidates(graph, selector, 5)
    const lines = envelope(`codegraph_context "${selector}": unresolved`, freshness, note)
    if (shared.total > 0) {
      lines.push(`That name is declared ${String(shared.total)} time(s). Pass one of these ids:`)
      for (const candidate of shared.candidates) lines.push(`- ${formatSymbol(candidate)} (id: ${candidate.id})`)
    } else {
      lines.push(`No symbol or file matched "${selector}" in ${root}. Use codegraph_find to get a name or an id.`)
    }
    return textOf(lines)
  }

  const symbolCalls = callsOf(graph, symbol.id, limit)
  const fileCalls = callsOf(graph, fileNodeId(symbol.path), limit)
  // `referencesTo`, not `calledBy`: both read the same edges, but `calledBy`
  // projects the raw `src` id into the `path` field (`js/main.js#function:boot`),
  // while `referencesTo` unpacks it into a path plus the CALLING SYMBOL's name —
  // which is the sentence a reader needs ("boot calls this at line 664").
  const called = referencesTo(graph, symbol.id, limit)
  const imported = importsOf(graph, symbol.path, limit)
  const docs = documentsFor(graph, symbol.id, limit)
  const siblings = symbolsInFile(graph, symbol.path, SIBLING_ROWS)
  const truncated = symbolCalls.truncated || fileCalls.truncated || called.truncated
    || imported.truncated || docs.truncated

  const lines = envelope(`codegraph_context ${formatSymbol(symbol)}`, freshness, note)
  lines.push(`id: ${symbol.id}`)
  lines.push(siblings.length >= SIBLING_ROWS
    ? `same file (first ${String(SIBLING_ROWS)} shown — pass "${symbol.path}" as \`symbol\` for the full outline):`
    : `same file (${String(siblings.length)}):`)
  for (const sibling of siblings) lines.push(`- ${formatSymbol(sibling)}`)
  if (symbolCalls.rows.length === 0) lines.push('calls made from here: none recorded')
  else {
    lines.push('calls made from here:')
    for (const edge of symbolCalls.rows) lines.push(`- ${edge.name ?? '?'} at line ${String(edge.line)}${edge.path === undefined ? '' : ` (${edge.path})`}`)
  }
  // File-scope calls are listed APART from the symbol's own. The index attributes
  // a top-level call to the file node, and merging the two lists made a function
  // look like it called everything its file does at load time.
  if (fileCalls.rows.length > 0) {
    lines.push('at file scope (not inside any declaration here):')
    for (const edge of fileCalls.rows) lines.push(`- ${edge.name ?? '?'} at line ${String(edge.line)}`)
  }
  if (called.rows.length === 0) lines.push('called by: none recorded — that is NOT proof of safety (references are resolved by name only)')
  else {
    lines.push(called.truncated
      ? `called by (${String(called.total)} reference(s), ${String(called.rows.length)} shown — TRUNCATED):`
      : `called by (${String(called.total)} reference(s)):`)
    for (const ref of called.rows) lines.push(`- ${ref.path}:${String(ref.line)}${ref.name === undefined ? '' : ` (${ref.name})`}`)
  }
  if (imported.rows.length > 0) {
    lines.push('imports:')
    for (const path of imported.rows) lines.push(`- ${path}`)
  }
  if (docs.rows.length === 0) lines.push('described in: no document mentions it')
  else {
    lines.push('described in:')
    for (const quote of quoteMentions(root, docs.rows, MAX_DOC_SNIPPETS)) {
      lines.push(`- ${quote.path}:${String(quote.line)}`)
      if (quote.text !== '') lines.push(`  > ${quote.text}`)
    }
    if (docs.rows.length > MAX_DOC_SNIPPETS) lines.push(`- … ${String(docs.rows.length - MAX_DOC_SNIPPETS)} more mention(s)`)
  }
  if (truncated) lines.push(`TRUNCATED: at least one list was cut at ${String(limit)} rows. Treat this as a sample, not the whole neighbourhood.`)
  return textOf(lines)
}

// ---------------------------------------------------------------------------
// Tool: overview
// ---------------------------------------------------------------------------

/** The extensions this build can parse, for the "nothing found" answer. */
function supportedExtensions() {
  const extensions = []
  for (const language of LANGUAGES) {
    if (language.bundled) extensions.push(...language.extensions)
  }
  return [...new Set(extensions)].sort().join(' ')
}

/**
 * The project overview, rendered from the plugin's own prompt block.
 *
 * `renderOverviewContext` is the plugin's tested 15-line renderer. It carries one
 * DSH-specific line (`memory_save`), which is filtered out here rather than
 * editing the copied core: the port must not fork the engine's text for one host
 * integration.
 */
function overviewText(root, freshness, note, graph) {
  const shape = projectOverview(graph, MAX_ROWS)
  const meta = readProjectMeta(graph.db)
  const gaps = coverageGaps(graph, meta)
  const lines = envelope(`codegraph_overview ${basename(root)} (${root}) — ${String(shape.files)} file(s), ${String(shape.symbols)} symbol(s), ${String(shape.edges)} edge(s)`, freshness, note)

  if (shape.files === 0) {
    // Honest empty answer: "0 files" is a fact about the extensions this build
    // parses, not about the project. Said explicitly, or the model reads an empty
    // overview as an empty project.
    lines.push(`Nothing indexed: no file under this path has an extension this server parses (${supportedExtensions()}).`)
    lines.push('Documents (.md/.mdx/.txt/.rst) are read only for symbol mentions, so a project of HTML files or prose alone produces an empty graph.')
    for (const gap of gaps) lines.push(`- ${gap}`)
    return textOf(lines)
  }

  // `renderOverviewContext` answers '' for a shape with no files, and that case is
  // handled above, so this split is line filtering rather than a second render:
  // the block's last line tells the model to save findings with `memory_save`,
  // which is a DSH-only tool this server does not have.
  const block = renderOverviewContext(shape, freshness === 'indexing' ? 'indexing' : 'current', undefined)
  for (const line of block.split('\n')) {
    if (line.includes('memory_save')) continue
    lines.push(line)
  }
  if (shape.truncated) lines.push('TRUNCATED: at least one list was cut at the row limit.')

  // WHERE THE SHAPE IS INCOMPLETE, right after it. The language split above counts
  // files by extension, so a language whose grammar is missing appears with a file
  // count and zero symbols — which reads as "this project has no CSS/Go/Rust
  // symbols" rather than "those files were never parsed". This is the sentence that
  // tells the two apart, and it names the wasm file and the directory.
  if (gaps.length > 0) {
    lines.push('Coverage — what this graph does NOT include (a missing symbol may be a gap here, not absent from the code):')
    for (const gap of gaps) lines.push(`- ${gap}`)
  }
  return textOf(lines)
}

async function toolOverview(args) {
  const root = resolveProject(args.project)
  const { freshness, note } = await prepare(root)
  return overviewText(root, freshness, note, projectEntry(root).graph)
}

// ---------------------------------------------------------------------------
// Tool: cleanup
// ---------------------------------------------------------------------------

/**
 * `codegraph_cleanup`: remove graph files that have gone unused.
 *
 * Deliberately synchronous: it only stats and unlinks a handful of files, and an
 * async pass could interleave with a tool call that is opening a graph.
 *
 * @param {object} args - `ttl_days` (number) and `dry_run` (boolean).
 * @returns {string} the report.
 */
function toolCleanup(args) {
  const ttlDays = clampTtlDays(args.ttl_days)
  const dryRun = parseBool(args.dry_run, false)
  return cleanupReport(ttlDays, dryRun)
}

// ---------------------------------------------------------------------------
// MCP stdio layer (JSON-RPC 2.0, newline-delimited; no SDK dependency)
// ---------------------------------------------------------------------------

const PROJECT_PROPERTY = {
  type: 'string',
  description: 'Absolute path of the project to query. Defaults to the server process working directory.',
}

const TOOLS = [
  {
    name: 'codegraph_find',
    description:
      'Find WHERE a symbol is DECLARED in this project, without reading or grepping files: answers '
      + '"where is X defined" in one call with its kind, file:line, parent symbol and call-site count. '
      + 'Use it as the first step of almost any codebase question — before grep, glob or opening files. '
      + 'Matching: an exact name wins; otherwise a case-insensitive substring search, so a partial name '
      + 'still finds candidates. A "not found" while freshness is indexing or stale means ask again in a '
      + 'moment. Every answer states how fresh the graph is.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The symbol name to look for. Exact names are preferred; a partial name falls back to a substring search.' },
        project: PROJECT_PROPERTY,
        limit: { type: 'number', description: 'Maximum matches to return (default 40, max 200).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'codegraph_impact',
    description:
      'Answer "who calls this / what breaks if I change it" in ONE call: a reverse reference walk over the '
      + "project's call graph, plus what the symbol's own file imports and the extends/implements/"
      + 'type-reference relationships that point at it. Use it BEFORE editing anything shared — a utility, a '
      + 'type, a public function — so the change does not surprise a caller you did not see. This is the '
      + 'reverse direction of codegraph_find. `depth` > 1 walks further up the chain (who calls the callers). '
      + 'References are resolved by NAME, so a call through an interface, a dynamic dispatch or a variable '
      + 'leaves no edge: an empty list means "no direct calls found", never "safe to change". When a name is '
      + 'declared more than once the candidates are returned instead of a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A symbol id from codegraph_find, or a name that is unique in this project.' },
        project: PROJECT_PROPERTY,
        depth: { type: 'number', description: 'How many levels of callers to walk up (default 1, max 4). Depth 1 is the direct callers.' },
        limit: { type: 'number', description: 'Maximum reference rows per symbol (default 40, max 200).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_context',
    description:
      "Read one symbol's whole neighbourhood in a single call: its declaration, the other symbols in the same "
      + 'file, the calls it makes, what calls it, what its file imports, and the project documents that mention '
      + 'it (with the sentence that mentions it). Use it when you need to UNDERSTAND a piece before changing it. '
      + 'Pass a FILE PATH instead of a symbol to get that file\u2019s outline — every symbol it declares, each with '
      + 'its call-site count and whether it is exported — which is the only reliable way to answer "what does '
      + 'this file define" or "which methods does this class have". Omit `symbol` to get the project overview.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A symbol id from codegraph_find, a name unique in this project, or a project file path for its outline. Omit to get the project overview.' },
        project: PROJECT_PROPERTY,
        limit: { type: 'number', description: 'Maximum rows per list (default 40, max 200).' },
      },
    },
  },
  {
    name: 'codegraph_overview',
    description:
      'The shape of a project, for orientation: file/symbol/edge counts, the language split, the files nothing '
      + 'imports (entry points, or a library\u2019s public surface) and the most-referenced symbols — the vocabulary '
      + 'to learn first. Call this FIRST in an unfamiliar repository, or whenever you are asked what a project '
      + 'is, where it starts, how it is organised or how to begin, INSTEAD of listing directories and reading '
      + 'files: the graph already holds that shape. The first call for a project builds its index (a one-off '
      + 'wait); later calls are incremental and report freshness.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_PROPERTY },
    },
  },
  {
    name: 'codegraph_cleanup',
    description:
      'Delete per-project graph files under the data directory that have not been used for `ttl_days` '
      + '(default 7; accepts any integer 1-365, common values 7/30/60/90). "Used" is the file mtime, which '
      + 'every query and rebuild refreshes, so a graph touched today is never removed. Only top-level files '
      + 'named `<project>-<8 hex>.sqlite` and their `-wal`/`-shm` companions qualify: nothing is searched '
      + 'recursively, grammars/ and node_modules/ are never touched, and graphs open in this server are '
      + 'skipped. Set `dry_run` to list what would be deleted without deleting it. A failure to unlink a '
      + 'locked file is logged and skipped, never fatal. The report names each removed file with its size and '
      + 'last-use time, the kept count, the bytes released and the current total size of data/. The same '
      + 'sweep runs once at startup, controlled by CODEGRAPH_DATA_TTL_DAYS (0 disables it).',
    inputSchema: {
      type: 'object',
      properties: {
        ttl_days: { type: 'number', description: 'Keep graphs used within this many days (integer 1-365, default 7). Common: 7, 30, 60, 90.' },
        dry_run: { type: 'boolean', description: 'List what would be deleted without deleting anything (default false).' },
      },
    },
  },
]

const HANDLERS = {
  codegraph_find: toolFind,
  codegraph_impact: toolImpact,
  codegraph_context: toolContext,
  codegraph_overview: toolOverview,
  codegraph_cleanup: toolCleanup,
}

/**
 * Set when stdout is gone (the client closed the pipe). Every later write is a
 * no-op: a server that keeps writing into a closed pipe throws EPIPE once per
 * answer, which buries the real cause in the log.
 */
let stdoutBroken = false

/** Requests still running, so `stdin end` cannot truncate an answer in flight. */
let pending = 0
/** True once stdin ended or a stream error asked for shutdown. */
let closing = false
/** True once the graphs are closed and the exit is scheduled. */
let finishing = false

function send(object) {
  if (stdoutBroken) return
  try {
    process.stdout.write(`${JSON.stringify(object)}\n`)
  } catch (error) {
    // EPIPE usually arrives through the 'error' listener below; a synchronous
    // throw is the TTY case, and both mean the same thing.
    stdoutBroken = true
    log(`stdout write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/**
 * Close the graphs and exit once stdout has drained.
 *
 * `process.exit()` DROPS whatever is still buffered in the pipe, which is exactly
 * how the last response of a session gets truncated: the client sends a request and
 * closes stdin, the answer is written, the process exits, the bytes never leave.
 * The empty write's callback runs after everything queued before it, and the timer
 * is the backstop for a pipe that is already gone (its callback would never run).
 */
function finish() {
  if (finishing) return
  finishing = true
  for (const entry of projects.values()) {
    try { entry.graph.close() } catch { /* already closed */ }
  }
  process.exitCode = 0
  // A closed stdout has nothing to flush; writing to it would just throw again.
  if (stdoutBroken) {
    process.exit(0)
    return
  }
  process.stdout.write('', () => { process.exit(0) })
  setTimeout(() => { process.exit(0) }, 2000).unref()
}

/** A JSON-RPC id that can be echoed back, or null. */
function usableId(id) {
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/** Run one request, tracking it so shutdown can wait for it. */
function dispatch(message) {
  pending += 1
  handleRequest(message)
    .catch((error) => sendError(usableId(message.id), -32603, error instanceof Error ? error.message : String(error)))
    .finally(() => {
      pending -= 1
      if (closing && pending === 0) finish()
    })
}

async function handleRequest(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'glm-codegraph', version: VERSION },
        },
      })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = params?.name
      const handler = HANDLERS[name]
      if (handler === undefined) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }], isError: true } })
        return
      }
      try {
        const text = await handler(params?.arguments ?? {})
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`tool ${name} failed: ${message}`)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } })
      }
      return
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

let buffer = Buffer.alloc(0)
/** True while the tail of an over-long line is being thrown away. */
let discarding = false

/**
 * Take every complete line out of the buffer and answer it.
 *
 * Errors are ANSWERS, not silence: a client that sends malformed JSON and gets
 * nothing back cannot tell a broken server from a slow one, and a dropped request
 * looks identical to a model that never called the tool. -32700 is "not JSON",
 * -32600 is "JSON but not a request", and the id is echoed whenever one exists.
 */
function pump() {
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) {
      // No newline within the cap: stop buffering and swallow the rest of the line.
      if (buffer.length > MAX_MESSAGE_BYTES) {
        buffer = Buffer.alloc(0)
        discarding = true
        sendError(null, -32600, `Message too large (limit ${String(MAX_MESSAGE_BYTES)} bytes); the request was discarded.`)
      }
      return
    }
    const raw = buffer.subarray(0, index)
    buffer = buffer.subarray(index + 1)
    if (discarding) {
      // The remainder of the line whose head was dropped.
      discarding = false
      continue
    }
    if (raw.length > MAX_MESSAGE_BYTES) {
      sendError(null, -32600, `Message too large (limit ${String(MAX_MESSAGE_BYTES)} bytes); the request was discarded.`)
      continue
    }
    const line = raw.toString('utf8').replace(/\r$/, '')
    if (line.trim() === '') continue

    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      sendError(null, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      sendError(null, -32600, 'Invalid Request: a JSON-RPC message must be a single object (batch requests are not supported)')
      continue
    }
    if (typeof message.method !== 'string' || message.method === '') {
      // This server sends no requests of its own, so an object carrying a result or
      // an error id matches nothing — it is a malformed request either way.
      sendError(usableId(message.id), -32600, 'Invalid Request: "method" must be a non-empty string')
      continue
    }
    // A message without an id is a notification (`notifications/initialized` and
    // friends), which needs no answer.
    if (message.id === undefined || message.id === null) continue
    dispatch(message)
  }
}

process.stdin.on('data', (chunk) => {
  if (closing) return
  buffer = Buffer.concat([buffer, chunk])
  pump()
})
process.stdin.on('error', (error) => {
  log(`stdin error: ${error instanceof Error ? error.message : String(error)}`)
  closing = true
  if (pending === 0) finish()
})
process.stdin.on('end', () => {
  // Wait for in-flight requests: the client may send a request and close stdin,
  // and exiting now would drop the answer that is still being computed.
  closing = true
  if (pending === 0) finish()
})
process.stdout.on('error', (error) => {
  stdoutBroken = true
  log(`stdout closed: ${error instanceof Error ? error.message : String(error)}`)
  closing = true
  if (pending === 0) finish()
})

log(`MCP server started (v${VERSION}, node ${process.version}, data: ${DATA_DIR})`)
startupDataCleanup()
const unavailable = unavailableGrammars()
log(
  `grammars: ${String(LANGUAGES.length - unavailable.length)} of ${String(LANGUAGES.length)} language ids ready`
  + (unavailable.length === 0
    ? ''
    : `; not installed: ${unavailable.map(language => language.id).join(', ')}`
      + ` — on-demand wasm goes in ${GRAMMAR_PATHS.downloadDir} as tree-sitter-<lang>.wasm, and files of those languages are skipped and reported, never silently empty`),
)
