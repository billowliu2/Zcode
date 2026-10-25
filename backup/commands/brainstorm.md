---
description: 需求梳理与设计对话：一次一问澄清目的/约束/成功标准，事实问题派 researcher 调研，2-3 方案对比后分段确认设计
argument-hint: <你的想法或需求描述>
skills: brainstorming
---

[brainstorming 模式] 用户要开始梳理以下需求。按 brainstorming 技能的完整流程推进：

1. 先看项目现状（AGENTS.md / README / 相关模块），需要深入就派 `researcher` 只读调研
2. 澄清循环：一次只问一个问题，优先用 `AskUserQuestion` 选择题；事实性未知先派 researcher 查证，不把可调研的问题抛给用户
3. 给 2-3 个带取舍的方案，推荐项先行
4. 分段呈现设计（每段 200-300 字），逐段向用户确认
5. 定稿写入 `docs/plans/YYYY-MM-DD-<主题>-design.md` 前先征得同意，不擅自 commit

在产出双方确认的设计之前，不写任何实现代码。

用户的需求描述：

$ARGUMENTS
