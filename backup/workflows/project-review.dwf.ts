/* zcode-workflow
description: 全项目体检工作流：按维度（内置六维：架构一致性/依赖健康/死代码/错误处理覆盖/安全基线/文档过期，可自定义）并行只读取证，每个维度一个审查员子代理，汇总成带证据与严重度的体检报告并落盘
  REVIEW-日期.md。体检的是整个项目的当前状态，与 task-review（复核单次任务）严格区分。
whenToUse: 拿到新项目想全面体检、周期性健康检查、大改动后确认全局状态时用。审的是项目整体静态质量（架构/依赖/死代码/错误处理/安全/文档），不是某次任务的完成度（那个用
  task-review）。
args:
  dimensions:
    type: json
    description: 体检维度列表（字符串数组，每条自带检查指引），留空用内置六维：架构与分层一致性 / 依赖健康 / 死代码与冗余 / 错误处理覆盖 /
      安全基线 / 文档与注释过期；最多 8 个
  path:
    type: string
    description: 体检范围（工作区内相对路径），默认整个工作区
    default: .
*/
// project-review — 全项目体检（迁移自 Kimi 技能家族的 project-review 定位，实现为 swarm 式工作流）
// 与 task-review 的边界：本工作流体检【整个项目的当前状态】，task-review 复核【一次任务的完成情况】。
// 子代理取证纪律内嵌于每条维度 prompt；发现属"候选问题"，主代理采信前须抽验证据。

interface Finding {
  /** 问题位置：文件路径（带行号更好，如 src/a.ts:42） */
  where: string;
  /** 一句话说清问题是什么（不是怎么修） */
  what: string;
  /** 证据：读到的代码行 / 跑过的命令与输出 */
  evidence: string;
  /** 严重度：high 预留给数据丢失/崩溃/安全问题；medium 明显缺陷；low 建议 */
  severity: "low" | "medium" | "high";
}

interface DimResult {
  /** 本维度名称 */
  dimension: string;
  /** 发现的问题（按严重度降序） */
  findings: Finding[];
  /** 检查过且没问题的方面（附检查位置，防止"没查"冒充"没问题"） */
  checked: string[];
}

// --- 参数收窄 ---------------------------------------------------------------

const scope = typeof args.path === "string" && args.path.trim() !== "" ? args.path.trim().replace(/\/+$/, "") : ".";

const DEFAULT_DIMENSIONS: string[] = [
  "架构与分层一致性：模块边界是否清晰、有无跨层引用、目录归属是否合理、同类实现是否重复分散",
  "依赖健康：清单里的依赖有无明显过期/已被弃用、有无声明了但全仓无引用的依赖、有无重复功能的库",
  "死代码与冗余：无引用的导出/文件、被注释掉的大段代码、空函数/占位实现、永远走不到的分支",
  "错误处理覆盖：新逻辑的 catch 是否吞错、异步是否漏 await、边界与空值路径、失败是否静默",
  "安全基线：硬编码密钥/凭证、注入风险（SQL/命令/eval）、权限校验缺位、不安全的外部输入处理",
  "文档与注释过期：README/注释与当前行为不符、配置项没写默认值说明、对外接口文档是否跟上了实现",
];

const rawDims = Array.isArray(args.dimensions) ? args.dimensions : [];
const dims: string[] = [];
for (const d of rawDims) {
  if (typeof d === "string" && d.trim() !== "") dims.push(d.trim());
}
if (dims.length === 0) dims.push(...DEFAULT_DIMENSIONS);
if (dims.length > 8) throw new Error(`project-review: 维度最多 8 个，当前 ${dims.length} 个`);

// --- 项目盘点（纯逻辑，不占 phase） -----------------------------------------

let inventory: string[] = [];
try {
  inventory = await files.glob(`${scope}/**/*`);
} catch {
  // 大仓库全量 glob 超限时退化为两层抽样
  try {
    const l1 = await files.glob(`${scope}/*`);
    const l2 = await files.glob(`${scope}/*/*`);
    inventory = [...new Set([...l1, ...l2])];
  } catch {
    inventory = [];
  }
}

let manifestText = "";
for (const f of [`${scope}/package.json`, `${scope}/AGENTS.md`, `${scope}/README.md`]) {
  try {
    manifestText += `\n--- ${f} 摘录 ---\n${(await files.read(f)).slice(0, 1500)}\n`;
  } catch {
    // 文件不存在则跳过
  }
}

const inventoryNote =
  inventory.length === 0
    ? "（文件清单不可得，请自行用 glob/grep 盘点）"
    : `文件清单（共 ${inventory.length} 个，抽样）：${inventory.slice(0, 60).join("、")}${inventory.length > 60 ? "…" : ""}`;

const sharedContext =
  `【项目盘点】体检范围：${scope === "." ? "整个工作区" : scope}\n${inventoryNote}\n${manifestText}\n` +
  `【纪律】只读取证：命令仅限只读（grep/find/git log/status/diff、读文件），禁止任何写操作与 git 变更命令；` +
  `每条发现必须带证据（file:line 或命令输出片段）；查过没问题的方面也要列入 checked；找不到问题就明确写"未发现问题"，不编造凑数；` +
  `需要运行环境才能判断的不要臆测，列入 checked 时注明"静态无法判定"。`;

// --- 仪表盘 -----------------------------------------------------------------

artifact.board("exam", {
  title: `项目体检进度（${dims.length} 个维度）`,
  key: "key",
  status: "status",
  columns: ["完成", "进行中"],
  cardTitle: "title",
  detail: [{ field: "note" }],
});

// --- 各维度并行体检 ---------------------------------------------------------

phase("各维度并行体检");
log(`体检范围 ${scope}，共 ${dims.length} 个维度并行开查（文件 ${inventory.length} 个）`);

const results: DimResult[] = [];
// 汇总报告需要每个维度的完整结果，因此这里是一次合理的屏障（join）
await Promise.all(
  dims.map(async (dim, i) => {
    report({ key: dim.slice(0, 12), title: dim.slice(0, 16), status: "进行中", note: "取证中" }, "exam");
    const worker = agent(`体检${i + 1}·${dim.slice(0, 6)}`, {
      system: "你是项目体检中的一个维度审查员，只读取证，禁止任何写操作与 git 变更命令；每条结论必须带证据。",
    });
    try {
      const r = await worker.ask<DimResult>(
        `你是项目体检中的一个维度审查员，只负责下面这一个维度，不要越界到其他维度。\n\n${sharedContext}\n\n` +
          `【你的维度】${dim}\n\n` +
          `【输出要求】返回一个 DimResult 对象：dimension 填维度名；findings 是发现的问题（每条带 where/what/evidence/severity，按严重度降序，只报你能指到位置的）；` +
          `checked 是你实际检查过且没问题的方面（附检查位置或命令）。发现不了问题就返回空 findings 并把查过的位置列全——这同样是有价值的结论。`,
      );
      const normalized: DimResult = {
        dimension: r.dimension || dim.slice(0, 12),
        findings: Array.isArray(r.findings) ? r.findings : [],
        checked: Array.isArray(r.checked) ? r.checked : [],
      };
      results[i] = normalized;
      report(
        {
          key: dim.slice(0, 12),
          title: dim.slice(0, 16),
          status: "完成",
          note: normalized.findings.length === 0 ? "未发现问题" : `${normalized.findings.length} 项发现`,
        },
        "exam",
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results[i] = { dimension: dim.slice(0, 12), findings: [], checked: [`维度执行失败：${error}`] };
      report({ key: dim.slice(0, 12), title: dim.slice(0, 16), status: "完成", note: `执行失败：${error.slice(0, 40)}` }, "exam");
    }
  }),
);

// --- 汇总与落盘 -------------------------------------------------------------

phase("汇总并落盘体检报告");

const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, dim: r.dimension })));
const high = allFindings.filter((f) => f.severity === "high").length;
const medium = allFindings.filter((f) => f.severity === "medium").length;
const low = allFindings.length - high - medium;

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120);
}

const reportLines = [
  `# 项目体检报告`,
  ``,
  `- 体检范围：${scope === "." ? "整个工作区" : scope}；维度：${dims.length} 个；盘点文件：${inventory.length} 个`,
  `- 结论：**${allFindings.length === 0 ? "未发现问题" : `共 ${allFindings.length} 项发现（高 ${high} / 中 ${medium} / 低 ${low}）`}**`,
  `- 性质说明：以下为各维度审查员的取证发现，属**候选问题**；采纳修复前建议由主代理抽验证据`,
  ``,
];
for (const r of results) {
  reportLines.push(`## ${r.dimension}`, ``);
  if (r.findings.length === 0) {
    reportLines.push(`未发现问题。已检查：${r.checked.length} 个方面。`, ``);
  } else {
    reportLines.push(`| 严重度 | 位置 | 问题 | 证据 |`, `|---|---|---|---|`);
    for (const f of r.findings) {
      reportLines.push(`| ${f.severity} | ${esc(f.where)} | ${esc(f.what)} | ${esc(f.evidence)} |`);
    }
    reportLines.push(``);
  }
  if (r.checked.length > 0) {
    reportLines.push(`**检查过没问题的方面**：`, ...r.checked.map((c) => `- ${c}`), ``);
  }
}
const reportMd = reportLines.join("\n");

const writer = agent("报告撰写员", {
  system: "你负责把给定的报告内容原样写入指定文件，只写这一个文件，写完读回确认。",
});
const filePath = await writer.ask<string>(
  `把下面的体检报告原样写入文件 REVIEW-<今天日期YYYY-MM-DD>.md（日期用你已知的今天，放在工作区根目录；只写这一个文件，不要改动其他任何文件）。` +
    `写完读回确认后，只返回你实际写入的文件路径，不要其他内容。\n\n${reportMd}`,
);

await artifact.markdown("report", reportMd, {
  title: `项目体检报告（${dims.length} 维度）`,
  description: `${allFindings.length === 0 ? "未发现问题" : `${allFindings.length} 项发现：高 ${high} / 中 ${medium} / 低 ${low}`}；逐维证据与已检查清单见正文。`,
  primary: true,
});

// 回流瘦身：完整内容只在落盘文件里；return 只带紧凑摘要，避免大通知膨胀主代理上下文
const compactFindings = allFindings.slice(0, 15).map((f) => ({
  severity: f.severity,
  where: f.where.slice(0, 80),
  what: f.what.slice(0, 100),
  evidence: f.evidence.slice(0, 120),
  dim: f.dim,
}));

return {
  conclusion:
    allFindings.length === 0
      ? `体检完成：${dims.length} 个维度均未发现问题（已检查方面见各维度 checked 清单）。报告已落盘 ${filePath}。`
      : `体检完成：${dims.length} 个维度共 ${allFindings.length} 项发现（高 ${high} / 中 ${medium} / 低 ${low}）。报告已落盘 ${filePath}；发现属候选问题，采纳前建议抽验证据。`,
  reportFile: filePath,
  findings: compactFindings,
  findingsTruncated: allFindings.length > compactFindings.length ? `另有 ${allFindings.length - compactFindings.length} 项见报告文件` : undefined,
  dimensionSummaries: results.map((r) => ({ dimension: r.dimension.slice(0, 20), findings: r.findings.length, checked: r.checked.length })),
  verified: ["每个维度由独立子代理只读取证，发现均带 file:line 或命令输出证据"],
  notCovered: ["发现未经第二人复核（候选问题）；需要运行环境才能判断的方面以静态标注为准"],
};
