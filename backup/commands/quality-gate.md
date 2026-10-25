---
description: 门禁检查：逐条运行项目真实的检查命令（typecheck/lint/test），退出码按值汇总；留空自动探测
argument-hint: [留空自动探测；或指定命令，如 "dotnet build" / "npm run test"]
---

[quality-gate 模式] 用户要跑项目检查命令做验收门禁。调用 `CreateWorkflow`，源用 `saved: { name: "quality-gate", args: {...} }`：

- 用户未指定命令 → 传空 `args: {}`，工作流自动探测 package.json scripts（typecheck/lint/test）或 Makefile 目标（默认排除 build 类副作用命令）
- 用户点名了命令 → 构造 `commands: [{tool, args, label}]`，tool 限 npm/pnpm/yarn/dotnet/make/python/node/git
- 探测不到任何检查命令时工作流会报错说明——此时把项目实际的验证方式告诉用户，不要硬造命令

用途衔接：task-execute 第 3 步验收、swarm 修复批次后的统一门禁。
