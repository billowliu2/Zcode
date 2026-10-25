/* zcode-workflow
description: 门禁工作流：逐项运行项目真实的检查命令（typecheck/lint/test 等），退出码按值汇总不中断；未传 commands
  时从 package.json/Makefile 自动探测（排除 build 类副作用命令），产出逐条结果表。适用于任务验收一键检查、修复批次后的统一门禁。
whenToUse: 任务执行完需要跑项目检查命令验收时；swarm 修复批次结束后的统一门禁；拿到一个项目想快速确认 typecheck/lint/test
  基线时。项目没有任何检查命令时不要用。
args:
  commands:
    type: json
    description: 命令列表 [{tool, args, label}]，tool 限
      npm/pnpm/yarn/dotnet/make/python/node/git；留空时自动探测 package.json
      scripts（typecheck/lint/test）或 Makefile 目标（check/lint/test），默认排除 build
      类副作用命令
  timeout_ms:
    type: number
    description: 单条命令超时毫秒数
    default: 300000
*/
// quality-gate — 门禁工作流：读项目清单 → 逐条跑真实命令 → 汇总
// 用途：task-execute 第 3 步验收一键跑；swarm 修复批次后的统一门禁。
// 退出码是"值"不是异常：非零不中断，汇总后如实报告。

interface GateResult {
  /** 命令的显示名（label 或 tool+args） */
  label: string;
  /** 完整命令行 */
  command: string;
  /** 进程退出码；null 表示未能执行（工具不支持/启动失败） */
  exitCode: number | null;
  /** 是否通过（exitCode === 0） */
  ok: boolean;
  /** 输出摘要（stdout/stderr 尾部，失败时更长） */
  output: string;
}

// --- 参数收窄 ---------------------------------------------------------------

const TIMEOUT = Math.trunc(Number(args.timeout_ms)) > 0 ? Math.trunc(Number(args.timeout_ms)) : 300000;
const SUPPORTED = ["npm", "pnpm", "yarn", "dotnet", "make", "python", "node", "git"];

interface CmdSpec {
  tool: string;
  args: string[];
  label: string;
}

const cmds: CmdSpec[] = [];
const rawCmds = Array.isArray(args.commands) ? args.commands : [];
for (const raw of rawCmds) {
  if (typeof raw !== "object" || raw === null) continue;
  const c = raw as { tool?: unknown; args?: unknown; label?: unknown };
  if (typeof c.tool !== "string" || !SUPPORTED.includes(c.tool)) continue;
  if (!Array.isArray(c.args)) continue;
  const a: string[] = [];
  for (const x of c.args) if (typeof x === "string") a.push(x);
  cmds.push({ tool: c.tool, args: a, label: typeof c.label === "string" && c.label !== "" ? c.label : `${c.tool} ${a.join(" ")}` });
}

// --- 自动探测（未显式传命令时，纯逻辑不占 phase） ---------------------------

if (cmds.length === 0) {
  try {
    const pkg = JSON.parse(await files.read("package.json")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    // 包管理器优先级：packageManager 声明 > pnpm-lock 线索 > 默认 npm
    let pm = "npm";
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm")) pm = "pnpm";
    try {
      await files.read("pnpm-lock.yaml");
      pm = "pnpm";
    } catch {
      // 无 pnpm 锁文件则保持现值
    }
    // 探测保守：只挑检查类脚本，排除 build/打包类副作用命令
    for (const name of ["typecheck", "lint", "test"]) {
      if (pkg.scripts && typeof pkg.scripts[name] === "string") {
        cmds.push({ tool: pm, args: ["run", name], label: `${pm} run ${name}` });
      }
    }
  } catch {
    // 无 package.json，继续看 Makefile
  }
  if (cmds.length === 0) {
    try {
      const mk = await files.read("Makefile");
      for (const t of ["check", "lint", "test"]) {
        if (new RegExp(`^${t}:`, "m").test(mk)) {
          cmds.push({ tool: "make", args: [t], label: `make ${t}` });
        }
      }
    } catch {
      // 无 Makefile
    }
  }
}

if (cmds.length === 0) {
  throw new Error(
    "quality-gate: 未探测到可运行的检查命令（无 package.json scripts 的 typecheck/lint/test，也无 Makefile check/lint/test 目标）。" +
      "请显式传 commands: [{tool, args, label}]，例如 [{\"tool\":\"dotnet\",\"args\":[\"build\"],\"label\":\"dotnet build\"}]",
  );
}

// --- 仪表盘 -----------------------------------------------------------------

artifact.table("gates", {
  title: `门禁结果（${cmds.length} 条命令）`,
  key: "label",
  columns: [
    { field: "label", label: "命令" },
    { field: "exitCode", label: "退出码" },
    { field: "status", label: "结果" },
  ],
});

// --- 逐条运行（顺序执行，避免资源争抢） --------------------------------------

phase("逐项运行门禁命令");
log(`共 ${cmds.length} 条门禁命令，顺序执行`);

const results: GateResult[] = [];
for (const c of cmds) {
  let r: { exitCode: number; stdout: string; stderr: string } | null = null;
  // world.run 的命令名必须是编译期字面量：按工具白名单分支，动态值只进 args
  switch (c.tool) {
    case "npm":
      r = await world.run("npm", c.args, { timeoutMs: TIMEOUT });
      break;
    case "pnpm":
      r = await world.run("pnpm", c.args, { timeoutMs: TIMEOUT });
      break;
    case "yarn":
      r = await world.run("yarn", c.args, { timeoutMs: TIMEOUT });
      break;
    case "dotnet":
      r = await world.run("dotnet", c.args, { timeoutMs: TIMEOUT });
      break;
    case "make":
      r = await world.run("make", c.args, { timeoutMs: TIMEOUT });
      break;
    case "python":
      r = await world.run("python", c.args, { timeoutMs: TIMEOUT });
      break;
    case "node":
      r = await world.run("node", c.args, { timeoutMs: TIMEOUT });
      break;
    case "git":
      r = await world.run("git", c.args, { timeoutMs: TIMEOUT });
      break;
    default:
      r = null;
  }
  if (r === null) {
    const g: GateResult = { label: c.label, command: `${c.tool} ${c.args.join(" ")}`, exitCode: null, ok: false, output: `工具 ${c.tool} 不在支持列表` };
    results.push(g);
    report({ label: c.label, exitCode: "-", status: "未执行" }, "gates");
    continue;
  }
  const tail = (r.exitCode === 0 ? (r.stderr + r.stdout) : (r.stdout + r.stderr)).trim().slice(-(r.exitCode === 0 ? 200 : 800));
  const g: GateResult = { label: c.label, command: `${c.tool} ${c.args.join(" ")}`, exitCode: r.exitCode, ok: r.exitCode === 0, output: tail };
  results.push(g);
  report({ label: c.label, exitCode: r.exitCode, status: r.exitCode === 0 ? "通过" : "失败" }, "gates");
  log(`${c.label} → ${r.exitCode === 0 ? "通过" : `失败（exit ${r.exitCode}）`}`);
}

// --- 汇总（纯逻辑） -----------------------------------------------------------

const passed = results.filter((g) => g.ok).length;
const failed = results.length - passed;

return {
  conclusion:
    failed === 0
      ? `门禁全绿：${passed}/${results.length} 条命令通过。`
      : `门禁未过：${passed}/${results.length} 通过，失败 ${failed} 条（${results.filter((g) => !g.ok).map((g) => g.label).join("、")}）——失败输出摘要在 results 内，修完重跑。`,
  results,
  verified: results.filter((g) => g.exitCode !== null).map((g) => `${g.command} → exit ${g.exitCode}`),
  notCovered: results.filter((g) => g.exitCode === null).map((g) => `${g.label}：${g.output}`),
};
