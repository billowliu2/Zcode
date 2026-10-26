# codegraph-mcp

Standalone MCP stdio server for a per-project code knowledge graph: tree-sitter
parses a project into symbols and edges, stores them in one SQLite file per
project (`node:sqlite`, no driver, no native build), and exposes five tools.

Ported from the DSH plugin **`D:\AIGC\dsh-app\plugins\plugin-codegraph`**. Nothing
in the source plugin is modified; this directory is a copy plus a new host shell.

| Path | What it is |
|---|---|
| `server.mjs` | The MCP shell: JSON-RPC framing, the five tools, the project/index state machine, freshness, data cleanup. The only file written for this port. |
| `core/` | 10 files copied **byte for byte** from the plugin's `src/` (see below). Do not edit. |
| `grammars/` | The plugin's `grammars/` directory, 9 `.wasm` (8 grammars + the tree-sitter runtime). |
| `data/` | Created on first use. One `<project>-<sha256[0:8]>.sqlite` per project queried. Not committed (`.gitignore`). |
| `node_modules/` | One dependency: `web-tree-sitter@^0.27.1`. Not committed. |

## Requirements

- Node **>= 22.18** (`.ts` loading without a build step; `node:sqlite`). `node:sqlite`
  prints an `ExperimentalWarning` on stderr — expected, not an error.
- `npm install` once, in this directory.

## Tools

| Tool | Arguments | Answers |
|---|---|---|
| `codegraph_find` | `name`, `project?`, `limit?` | Where a symbol is declared: kind, `path:line`, parent symbol, call-site count, `id`. |
| `codegraph_impact` | `symbol`, `project?`, `depth?`, `limit?` | Who references/calls it, what its file imports, and the `extends`/`implements`/`type_refs`/`exports` relationships. `depth` > 1 walks up the call chain. |
| `codegraph_context` | `symbol?`, `project?`, `limit?` | A symbol's neighbourhood: declaration, same-file symbols, outgoing and incoming edges, imports, and the sentences in project documents that mention it. Pass a **file path** for a file outline; omit `symbol` for the overview. |
| `codegraph_overview` | `project?` | Project shape: counts, language split, entry-point candidates, the most-referenced symbols. |
| `codegraph_cleanup` | `ttl_days?`, `dry_run?` | Delete graph files unused for `ttl_days` days (default 7, range 1–365). Reports each removed file with size and last-use time, the kept count, bytes released and the current size of `data/`. `dry_run` only lists. |

`project` defaults to the server process's working directory. **Pass it explicitly**
(the session's project root) — the server's own cwd is whatever ZCode launched it in.

Every answer starts with the same three lines:

```
codegraph_find "x" in <project>: N match(es)
freshness: current            # current | stale | indexing
note: <one sentence, always present>
```

- `current` — the graph was verified against the working tree within
  `CODEGRAPH_RECHECK_MS` (default 30s).
- `indexing` — a pass is running (or the previous one failed and the next call will
  retry it); the answer may be incomplete.
- `stale` — the graph is provably behind **and** the rebuild failed; the note says
  from when the rows are and why.

**Coverage is reported separately from freshness.** A project where some files
could not be parsed (grammar not installed, no extraction rules, syntax errors)
answers with *"up to date … but does NOT cover the whole project"* plus the exact
files and the missing `.wasm`. Missing files are never silently dropped:
`codegraph_overview` ends with a `Coverage —` section, and the index pass logs the
same counts on stderr.

Indexing is on demand: the first query for a project runs a full pass and waits
for it; after that passes are incremental (unchanged files are skipped by
mtime+size), and a graph older than the re-check window is re-verified before it
answers.

## Data cleanup

`data/` accumulates one `.sqlite` file per project ever queried. `codegraph_cleanup`
removes the graphs nobody has used for a while. "Used" is the file's **mtime**,
which every query or rebuild refreshes, so a graph touched today is never removed.

| Call (`tools/call` arguments) | Effect |
|---|---|
| `{"ttl_days": 7}` | Default: delete graphs unused for 7+ days. |
| `{"ttl_days": 30}` | Monthly housekeeping — keep a month of project graphs. |
| `{"ttl_days": 60, "dry_run": true}` | List what a 60-day sweep *would* delete, delete nothing. |
| `{"ttl_days": 90}` | Quarter of a year — for a workstation that revisits old repos. |

`ttl_days` accepts any integer **1–365**; `0`, negatives and values above 365 are
rejected with an error (0 is reserved for *disabling* the environment-variable
sweep, so it must not mean "delete everything" in a tool call). `dry_run` marks
the report `DRY RUN — nothing was deleted (未删除)`.

The report names every removed file, its size and last-use time, then the kept
count, the bytes released and the current total size of `data/`:

```
codegraph_cleanup done
data: D:\Zcode\mcp\glm-codegraph\data
ttl: 7 day(s) — a graph is stale when last used before 2026-10-19T02:43:13.210Z (mtime)
graph files: 4 — removed 1, kept 3, skipped (open) 0, failed 0
removed:
- old-test-0000aaaa.sqlite — 5.0 KB — last used 2026-10-16T02:43:12.590Z
kept (within the ttl):
- Client-4bf0830c.sqlite — 57.4 MB — last used 2026-10-26T02:33:57.106Z
...
released: 5.0 KB
data/ total now: 57.5 MB
```

### Startup sweep

At boot the server runs the same cleanup **once**, controlled by
`CODEGRAPH_DATA_TTL_DAYS` (default `7`; `0` disables it). It does not scan on a
timer: a user who wants to keep 90 days must not lose a 30-day-old graph to a
background pass. One line lands on stderr:

```
[codegraph] data cleanup: removed 1 stale graph(s) (ttl 7d)
[codegraph] data cleanup: nothing stale (ttl 7d)
[codegraph] data cleanup: disabled (CODEGRAPH_DATA_TTL_DAYS=0)
```

### Safety boundaries

- Only the **top level** of `data/` is scanned (`readdir` without recursion); no
  subdirectory is ever entered.
- Only regular files whose name matches `<project>-<8 hex>.sqlite` qualify, plus
  that exact file's `-wal` / `-shm` companions. Anything else in `data/` —
  `grammars/`, a hand-copied file, another tool's database — is never a candidate.
- A graph **open in the running server** is skipped even if its mtime looks old.
- A file that cannot be unlinked (locked by another process, permissions) is
  logged and skipped; the sweep continues and the report lists it under `failed`.
- The main file is removed **after** its `-wal`/`-shm` companions, so a partial
  pass cannot leave an orphan WAL behind.
- Nothing is ever written to stdout by cleanup: the tool report is the tool
  result, and the startup sweep logs to stderr only.

## Register it

Add to `~/.zcode/cli/config.json` under `mcp.servers` (same shape as the existing
`glm-websearch` entry):

```json
{
  "mcp": {
    "servers": {
      "glm-codegraph": {
        "type": "stdio",
        "command": "node",
        "args": ["D:/Zcode/mcp/glm-codegraph/server.mjs"],
        "timeoutMs": 120000
      }
    }
  }
}
```

`timeoutMs` is deliberately generous: the first call for a large project is a full
index (a 39-file TypeScript project measured 415 ms; a 20k-file repo will not be).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CODEGRAPH_DATA_DIR` | `<this dir>/data` | Where the per-project `.sqlite` files live. |
| `CODEGRAPH_RECHECK_MS` | `30000` | How old a graph may be before a tool call re-verifies it (git HEAD + one incremental pass). `0` = build on first touch only. |
| `CODEGRAPH_DATA_TTL_DAYS` | `7` | Startup sweep: delete graph files unused for this many days (any positive integer, clamped to 365). `0` (or negative) disables the startup sweep; the `codegraph_cleanup` tool still works. |

## Languages and grammars

The table in `core/languages.ts` has **17 language ids**. This installation ships
**8 grammar files** covering **9 ids** (C and C++ share the `cpp` grammar):

| Ids with a grammar | Grammar file |
|---|---|
| `typescript` | `tree-sitter-typescript.wasm` |
| `tsx` | `tree-sitter-tsx.wasm` |
| `javascript` | `tree-sitter-javascript.wasm` |
| `python` | `tree-sitter-python.wasm` |
| `go` | `tree-sitter-go.wasm` |
| `java` | `tree-sitter-java.wasm` |
| `c`, `cpp` | `tree-sitter-cpp.wasm` (the set has no pure-C grammar; C parses through C++) |
| `c_sharp` | `tree-sitter-c-sharp.wasm` (the id and the file name disagree upstream) |

The other 8 ids — `rust`, `ruby`, `php`, `bash`, `css`, `ini`, `powershell`,
`regex` — have no grammar here. Files of those languages are still counted in the
graph's file list but contribute **no symbols**, and every answer says so.

### Adding an on-demand language by hand

This port does **not** download grammars (the plugin's settings page did). To enable
one, copy its wasm into `data/grammars/` under the exact name the table expects:

```
mkdir D:\Zcode\mcp\glm-codegraph\data\grammars
copy tree-sitter-css.wasm D:\Zcode\mcp\glm-codegraph\data\grammars\
```

The file must be named `tree-sitter-<grammar>.wasm`, where `<grammar>` is the
`grammar` field of that language in `core/languages.ts` (note `c_sharp` →
`tree-sitter-c-sharp.wasm`). Source of the files: the same package the plugin's
bundled grammars came from, `@vscode/tree-sitter-wasm@0.3.1/wasm` — a grammar from a
different build can fail to load with an ABI mismatch.

After placing a wasm, the files of that language are parsed on the next index pass.
Force one by deleting the project's `.sqlite` file (derived data — a rebuild is the
repair) or by waiting for the re-check window.

## Keeping `core/` in sync with the plugin

`core/` is a **verbatim copy** of these plugin files, and must stay that way — the
port's value is that the engine is the one that was tested, not a fork of it:

```
src/parse.ts  src/indexer.ts  src/query.ts  src/store.ts  src/languages.ts
src/tree-sitter.ts  src/queue.ts  src/remove-tree.ts  src/docs.ts  src/prompt.ts
```

To pick up an upstream change, re-copy them and prove the copy:

```bash
cp D:/AIGC/dsh-app/plugins/plugin-codegraph/src/{parse,indexer,query,store,languages,tree-sitter,queue,remove-tree,docs,prompt}.ts D:/Zcode/mcp/glm-codegraph/core/
node -e "const c=require('node:crypto'),f=require('node:fs');for(const n of ['parse','indexer','query','store','languages','tree-sitter','queue','remove-tree','docs','prompt'])console.log(n, c.createHash('sha256').update(f.readFileSync('core/'+n+'.ts')).digest('hex')===c.createHash('sha256').update(f.readFileSync('D:/AIGC/dsh-app/plugins/plugin-codegraph/src/'+n+'.ts')).digest('hex')?'OK':'DIFFERS')"
```

All ten must print `OK`. `node --check core/*.ts` should also pass — Node 22 strips
the types at load time, so there is no build step and no `tsc`.

Host-specific work belongs in `server.mjs`, never in `core/`:

- tool registration, argument handling, rendering (the plugin used `defineTool`);
- the DSH settings routes and system-prompt injection (dropped);
- `prompt.ts`'s `memory_save` line (a DSH-only tool) is filtered when rendering;
- `query.ts`'s `name LIKE '%<q>%'` has no `ESCAPE` clause, so `find` routes queries
  containing `%` or `_` through an `instr()` query of its own (see
  `findSymbolsLiteral` in `server.mjs`);
- `queue.ts` is copied for parity but unused: the stdio server serialises passes
  per project itself.

## Known limits

- References are resolved **by name** from syntax alone. A call through an
  interface, a dynamic dispatch or a variable leaves no edge, so an empty
  `codegraph_impact` means "no direct calls found", not "safe to change".
- Cross-project queries are impossible by construction (one database per project).
- Indexing skips `node_modules`, `dist`, `build`, `target`, `vendor`, `obj`, `bin`,
  dot-directories and files over 1.5 MB; the file budget is 20,000 per project and
  a truncated index says so.
- `.html`-embedded JavaScript is not parsed (no `.html` grammar in the table);
  documents are `.md`, `.mdx`, `.txt`, `.rst`.
