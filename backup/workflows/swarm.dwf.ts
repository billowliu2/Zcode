/* zcode-workflow
description: 批量并行子代理工作流：把一个含 {{item}}
  占位符的任务模板扇出到条目列表，每个条目一个子代理并行执行，逐项汇报并汇总成报告；支持 dry_run
  预览、同上下文追问（followups）、输出三档投影与批次进度看板。迁移自 dsh-app 的 plugin-swarm。
whenToUse: 当请求可分解为多个相互独立、互不重叠的并行子任务（分开的分析、互不重叠区域的逐模块修改、批量查询）时使用；有依赖或共享可变状态的子任务不要用。
args:
  dry_run:
    type: boolean
    description: 只校验与展开预览，不执行任何子任务
    default: false
  followups:
    type: json
    description: 对指定条目的追问 [{index, followup}]，同一条目沿用原上下文
  items:
    type: json
    description: 条目列表（字符串数组）：每个并行子任务的差异部分
    required: true
  label:
    type: string
    description: 批次标签，用于结果头部与报告标题
    default: 批量任务
  max_items:
    type: number
    description: 批次条目数上限
    default: 8
  output_mode:
    type: string
    description: 输出投影：full（截 4000 字）/ summary（截 500 字）/ status_only（仅状态）
    default: summary
  persona:
    type: string
    description: 整批子代理的人设预设——coder（实现纪律：先读后改/找调用方/最小diff/验证）或 reviewer（评审纪律：只读取证/结论带证据/分级标注），也可传任意自定义系统提示补充
  prompt_template:
    type: string
    description: 共享指令模板，必须包含 {{item}} 占位符
    required: true
  read_only:
    type: boolean
    description: 子代理只读约束（禁止修改任何文件）
    default: false
  shared_context:
    type: string
    description: 所有条目共享的背景（项目约定、文件清单等），会作为前缀加到每条 prompt
*/
// swarm — 批量并行子代理工作流（迁移自 @dsh-app/plugin-swarm）
// 把一个含 {{item}} 占位符的任务模板扇出到条目列表，每个条目一个子代理并行执行，
// 逐项汇报，支持 dry_run 预览与对指定条目的同上下文追问。
// 传输类失败由工作流运行时自动重试与自适应并发处理，脚本不写重试循环。

interface ItemOutcome {
  /** 条目序号，从 0 开始。 */
  index: number;
  /** 条目原文。 */
  item: string;
  /** 该项最终状态。 */
  status: "已完成" | "失败";
  /** 子代理最终汇报，按 output_mode 截断。 */
  output?: string;
  /** 失败原因，仅失败项。 */
  error?: string;
}

interface BatchReturn {
  /** 两三句话回答这批任务做得怎么样。 */
  conclusion: string;
  outcomes: ItemOutcome[];
  /** 拆分质量提示，供下次拆分自我修正。 */
  warnings: string[];
  verified: string[];
  notCovered: string[];
}

// --- 参数收窄（args 的值是 unknown，先窄化再使用） --------------------------

const rawItems = args.items;
if (!Array.isArray(rawItems)) throw new Error("swarm: `items` 必须是字符串数组");
for (const [i, v] of rawItems.entries()) {
  if (typeof v !== "string") throw new Error(`swarm: items[${i}] 不是字符串`);
}
const items: string[] = rawItems as string[];

const promptTemplate = typeof args.prompt_template === "string" ? args.prompt_template : undefined;
const sharedContext = typeof args.shared_context === "string" ? args.shared_context : "";
const label = typeof args.label === "string" && args.label.trim() !== "" ? args.label.trim() : "批量任务";
const outputMode =
  args.output_mode === "full" || args.output_mode === "status_only" ? args.output_mode : "summary";
const dryRun = args.dry_run === true;
const readOnly = args.read_only === true;
const maxItems = Math.trunc(Number(args.max_items)) >= 2 ? Math.trunc(Number(args.max_items)) : 8;

const rawFollowups = Array.isArray(args.followups) ? args.followups : [];
interface Followup {
  index: number;
  followup: string;
}
const followups: Followup[] = [];
for (const raw of rawFollowups) {
  if (typeof raw !== "object" || raw === null) throw new Error("swarm: followups 每项须为 {index, followup}");
  const f = raw as { index?: unknown; followup?: unknown };
  if (typeof f.index !== "number" || !Number.isInteger(f.index)) throw new Error("swarm: followup 的 index 须为整数");
  if (typeof f.followup !== "string" || f.followup.trim() === "") throw new Error("swarm: followup 的 followup 须为非空字符串");
  followups.push({ index: f.index, followup: f.followup });
}

// --- 展开与校验（移植自 plugin-swarm expand.ts，语义原样） -------------------

const MIN_ITEMS = 2;
const ITEM_PLACEHOLDER = /\{\{\s*item\s*\}\}/u;
const MIN_ITEM_HINT_LENGTH = 10;
const MIN_TEMPLATE_HINT_LENGTH = 80;

function flat(text: string, n: number): string {
  const f = text.trim().replace(/\s+/g, " ");
  return f.length > n ? `${f.slice(0, n)}…` : f;
}

if (items.length === 0) {
  throw new Error("swarm: `items` 不能为空 —— 空批次无事可做");
}
if (promptTemplate === undefined) {
  throw new Error("swarm: 提供 `items` 时 `prompt_template` 必填");
}
if (items.length < MIN_ITEMS) {
  throw new Error(`swarm: 含新条目的批次至少需要 ${MIN_ITEMS} 项 —— 单个子任务不该用批量工具`);
}
if (items.length > maxItems) {
  throw new Error(`swarm: 批次有 ${items.length} 项，超过上限 ${maxItems}（可用 max_items 参数调整）`);
}
if (!ITEM_PLACEHOLDER.test(promptTemplate)) {
  throw new Error("swarm: `prompt_template` 必须包含 {{item}} 占位符");
}
const seenItems = new Set<string>();
for (const item of items) {
  const key = item.trim();
  if (key.length === 0) throw new Error("swarm: `items` 含空条目");
  if (seenItems.has(key)) throw new Error(`swarm: \`items\` 存在重复条目 "${key.slice(0, 60)}"`);
  seenItems.add(key);
}
const seenFollowups = new Set<number>();
for (const f of followups) {
  if (f.index < 0 || f.index >= items.length) throw new Error(`swarm: followup 引用了不存在的条目序号 ${f.index}`);
  if (seenFollowups.has(f.index)) throw new Error(`swarm: followup 对条目 ${f.index} 重复追问 —— 应合并为一条`);
  seenFollowups.add(f.index);
}

const sharedPrefix = sharedContext.trim() === "" ? "" : `${sharedContext.trim()}\n\n---\n\n`;
interface Task {
  index: number;
  item: string;
  prompt: string;
}
const tasks: Task[] = items.map((item, index) => ({
  index,
  item,
  // split/join：条目文本逐字插入，其中的 $&/$' 等序列保持字面义
  prompt: sharedPrefix + promptTemplate.split(ITEM_PLACEHOLDER).join(item),
}));

const warnings: string[] = [];
for (const [index, item] of items.entries()) {
  if (item.trim().length < MIN_ITEM_HINT_LENGTH) {
    warnings.push(`条目 [${index}] "${item.trim()}" 很短 —— 每条应写明输入、预期输出与完成判据`);
  }
}
if (promptTemplate.trim().length < MIN_TEMPLATE_HINT_LENGTH) {
  warnings.push("prompt_template 很短 —— 子代理只能看到展开后的 prompt，请写全共享指令与明确的完成判据");
}
if (sharedPrefix === "" && promptTemplate.length < 200) {
  warnings.push("建议把所有条目都需要的背景（项目约定、文件清单）放进 shared_context，而不是挤在模板里");
}

// --- 输出投影（移植自 orchestrator.ts projectOutputItems） -------------------

const FULL_OUTPUT_LIMIT = 4000;
const SUMMARY_OUTPUT_LIMIT = 500;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[已截断 ${text.length - limit} 字符]`;
}

function projectOutput(text: string | undefined): string | undefined {
  if (text === undefined || outputMode === "status_only") return undefined;
  return truncate(text, outputMode === "full" ? FULL_OUTPUT_LIMIT : SUMMARY_OUTPUT_LIMIT);
}

// --- dry_run：只校验与展开，不执行 -------------------------------------------

if (dryRun) {
  log(`dry_run：批次校验通过，共 ${tasks.length} 项，未执行任何子任务`);
  return {
    conclusion: `dry_run 通过：批次「${label}」共 ${tasks.length} 项，占位符与规则校验均通过，质量提示 ${warnings.length} 条。`,
    previews: tasks.map((t) => ({ index: t.index, item: t.item, prompt: t.prompt })),
    warnings,
    verified: ["仅做校验与展开预览，未执行任何子任务"],
    notCovered: ["子任务实际执行（dry_run 不执行）"],
  };
}

// --- 批次仪表盘：逐项落卡，随执行推进 ---------------------------------------

artifact.board("batch", {
  title: `批次「${label}」执行进度`,
  key: "key",
  status: "status",
  columns: ["已完成", "失败"],
  cardTitle: "title",
  detail: [{ field: "note" }],
});

// --- 并行执行 ---------------------------------------------------------------

const PERSONA_PRESETS: Record<string, string> = {
  coder:
    "你沿用资深全栈工程师的实现纪律：任何文件先读后改，用最小 diff；改签名/改名/删导出前全仓搜索旧符号并同步所有调用点；" +
    "验证命令先从项目清单（package.json scripts / Makefile / CI 配置）确认真实存在再跑；" +
    "禁止 git commit/push，禁止执行 install/build 产物/migrate 等副作用命令；" +
    "不留 TODO/占位代码；交付按「做了什么/改动清单 file:line/验证到什么程度/未完成项」结构汇报。",
  reviewer:
    "你沿用专职评审员的取证纪律：只读取证，命令仅限只读操作（git diff/log/status/grep、读文件）；" +
    "每条结论必须带 file:line 或命令输出证据；查过没问题的部分也要列出；找不到问题就明确写该方面未发现问题，不编造凑数；" +
    "需要运行环境才能判断的写进信息缺口；每条发现标注证据分级（A 已核实 / B 旁证 / C 无法核实）。",
  researcher:
    "你沿用资深调研员的取证纪律：本地检索与 git 考古只用只读命令；网络搜索优先 mcp__glm-websearch__websearch，关键结论读原文核对；" +
    "每条结论必须带来源（file:line / 命令输出 / URL），区分事实与推断；未查明的标注已尝试路径与所缺信息，不以不清楚为借口；" +
    "源项目零修改，临时整理只写 .research/ 目录。",
};
const personaArg = typeof args.persona === "string" ? args.persona.trim() : "";
const personaPreset = PERSONA_PRESETS[personaArg] ?? "";
const personaCustom = personaArg !== "" && personaPreset === "" ? personaArg : "";
const persona = {
  system:
    "你是批量任务中的一名并行执行者，只看到分配给你的这一条任务，把它完整做完并汇报。" +
    personaPreset +
    personaCustom +
    "汇报包含：做了什么、关键位置（file:line，如适用）、验证到什么程度、未完成的部分明说。" +
    "若任务自相矛盾或缺少无法推断的关键信息，说明阻塞点，不要猜测。" +
    (readOnly ? "本次为只读任务：禁止修改、创建或删除任何文件。" : ""),
};

phase("并行执行每个条目");
log(`批次「${label}」共 ${tasks.length} 项，开始并行执行`);
const workers: Agent[] = [];
const outcomes: ItemOutcome[] = [];
// 汇总报告需要每一项的结果，因此这里是一次合理的屏障（join）
await Promise.all(
  tasks.map(async (task) => {
    const worker = agent(`任务${task.index + 1}·${flat(task.item, 8)}`, persona);
    workers[task.index] = worker;
    try {
      const output = await worker.ask(task.prompt);
      outcomes[task.index] = { index: task.index, item: task.item, status: "已完成", output };
      report(
        { key: `#${task.index + 1}`, title: flat(task.item, 24), status: "已完成", note: flat(output, 60) },
        "batch",
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes[task.index] = { index: task.index, item: task.item, status: "失败", error };
      report(
        { key: `#${task.index + 1}`, title: flat(task.item, 24), status: "失败", note: flat(error, 60) },
        "batch",
      );
    }
  }),
);

// --- 对指定条目追问（同一条目上下文保留，等价原版 resume 语义） ---------------

if (followups.length > 0) {
  phase("对指定条目追问");
  log(`对 ${followups.length} 个条目追问（沿用各自上下文）`);
  await Promise.all(
    followups.map(async (f) => {
      const worker = workers[f.index];
      const before = outcomes[f.index];
      try {
        const output = await worker.ask(f.followup);
        outcomes[f.index] = { index: f.index, item: before.item, status: "已完成", output };
        report(
          { key: `#${f.index + 1}`, title: flat(before.item, 24), status: "已完成", note: `追问后：${flat(output, 50)}` },
          "batch",
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        outcomes[f.index] = { index: f.index, item: before.item, status: "失败", error };
        report(
          { key: `#${f.index + 1}`, title: flat(before.item, 24), status: "失败", note: `追问失败：${flat(error, 50)}` },
          "batch",
        );
      }
    }),
  );
}

// --- 汇总（纯逻辑 + 发布交付物） --------------------------------------------

const projected = outcomes.map((o) => ({ ...o, output: projectOutput(o.output) }));
const completed = projected.filter((o) => o.status === "已完成").length;
const failed = projected.length - completed;

const reportLines = [
  `# 批次「${label}」报告`,
  "",
  `${completed} 项完成，${failed} 项失败，共 ${projected.length} 项。`,
  "",
  "| # | 条目 | 状态 | 结果 |",
  "|---|---|---|---|",
  ...projected.map((o) =>
    `| ${o.index + 1} | ${flat(o.item, 30).replace(/\|/g, "\\|")} | ${o.status} | ${
      o.status === "失败"
        ? flat(o.error ?? "未知原因", 80).replace(/\|/g, "\\|")
        : flat(o.output ?? "", 120).replace(/\|/g, "\\|").replace(/\n/g, " ")
    } |`,
  ),
];
if (warnings.length > 0) {
  reportLines.push("", "## 拆分质量提示", ...warnings.map((w) => `- ${w}`));
}
await artifact.markdown("report", reportLines.join("\n"), {
  title: `批量任务报告：${label}`,
  description: `${completed}/${projected.length} 项完成${failed > 0 ? `，${failed} 项失败` : ""}。逐项结果与拆分质量提示。`,
  primary: true,
});

const batchReturn: BatchReturn = {
  conclusion:
    `批次「${label}」：${projected.length} 项中 ${completed} 项完成${failed > 0 ? `，${failed} 项失败（${projected.filter((o) => o.status === "失败").map((o) => `#${o.index + 1}`).join("、")}）` : ""}。` +
    (warnings.length > 0 ? ` 另有 ${warnings.length} 条拆分质量提示，见 warnings。` : ""),
  outcomes: projected,
  warnings,
  verified: ["每个条目由独立子代理执行，汇报其最终输出"],
  notCovered: ["子代理的汇报内容未经独立复核；需要逐项核实时可再派 reviewer 类子代理"],
};
return batchReturn;
