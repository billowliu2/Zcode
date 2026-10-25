# ZCode 自定义资产备份与迁移指南

本目录是 ZCode 自定义配置的备份副本，同时是**迁移到其他电脑的迁移包**。生效位置不在本目录——ZCode 从 `C:\Users\<用户名>\.zcode\` 读取生效配置。

## 目录清单

| 备份路径 | 内容 | 生效位置 |
|---|---|---|
| `agents/` | 自定义子代理：coder（全栈实现）、reviewer（专职评审）、researcher（综合调研） | `~/.zcode/agents/` |
| `skills/` | 自定义技能：task-execute（任务编排执行，含 references）、task-review（完成复核，含 references）、brainstorming（需求梳理） | `~/.zcode/skills/` |
| `commands/` | 斜杠命令：/task-execute、/task-review、/swarm、/brainstorm、/project-review、/quality-gate | `~/.zcode/commands/` |
| `workflows/` | 保存的工作流：swarm（批量并行，coder/reviewer/researcher 三人设）、project-review（全项目体检）、quality-gate（检查命令门禁） | `~/.zcode/workflows/` |
| `AGENTS.md` | 用户级全局指令（搜索优先级 mcp__glm-websearch__websearch、批量任务路由） | `~/.zcode/AGENTS.md` |

同级 `../mcp/` 是 MCP 服务器实体（glm-websearch 搜索、glm-vision 识图），在源机上是生效位置。

## 迁移到新电脑（按顺序执行）

### 前置条件

- 新机安装 ZCode 并完成首次启动；安装 Node.js 18+（MCP 与工作流依赖）
- 把整个 `D:\Zcode` 目录拷到新机**相同盘符路径**（MCP 注册用的是绝对路径 `D:/Zcode/mcp/...`；如果新机路径不同，第 4 步里同步改）

### 第 1 步：铺设资产到 ~/.zcode

Git Bash 执行（~ 指向新机用户目录）：

```bash
mkdir -p ~/.zcode/agents ~/.zcode/skills ~/.zcode/commands ~/.zcode/workflows
cp /d/Zcode/backup/agents/*.md ~/.zcode/agents/
cp -r /d/Zcode/backup/skills/task-execute /d/Zcode/backup/skills/task-review /d/Zcode/backup/skills/brainstorming ~/.zcode/skills/
cp /d/Zcode/backup/commands/*.md ~/.zcode/commands/
cp /d/Zcode/backup/workflows/*.dwf.ts ~/.zcode/workflows/
cp /d/Zcode/backup/AGENTS.md ~/.zcode/AGENTS.md
```

### 第 2 步：注册 MCP

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 下加入两个条目（**密钥需从源机另行安全获取，不要存入本备份**）：

```json
"glm-vision": {
  "type": "stdio",
  "command": "node",
  "args": ["D:/Zcode/mcp/glm-vision/mcp/server.mjs"],
  "env": {
    "VISION_API_PROTOCOL": "openai",
    "VISION_API_URL": "<MiniMax API 地址>",
    "VISION_API_KEY": "<MiniMax API Key>",
    "VISION_MODEL": "<视觉模型名>",
    "VISION_MAX_TOKENS": "524288",
    "VISION_FETCH_TIMEOUT_MS": "100000"
  },
  "timeoutMs": 120000
},
"glm-websearch": {
  "type": "stdio",
  "command": "node",
  "args": ["D:/Zcode/mcp/glm-websearch/server.mjs"],
  "timeoutMs": 45000
}
```

要点：glm-websearch 四引擎全免 key，无需 env；glm-vision 的 env 照源机 `config.json` 抄（思考型视觉模型必须给足 `VISION_MAX_TOKENS`）。

### 第 3 步：供应商与模型（手动，含密钥不入包）

在源机 `~/.zcode/v2/provider_config.json` 与新机 UI 之间手动迁移：

- CodingPlan.Site 类中转：协议 **openai-chat-completions**、baseUrl **必须带 `/v1`**（少 /v1 会打到中转站的坏路由，症状是子代理空响应——这是踩过的坑）
- 各模型的 `optionSpecs.reasoningLevel` 档位声明照源机抄；MiniMax 类强制思考模型**不要给 disabled 档**
- 模型绑定（agents-state.json / 代理 frontmatter 的 model）可在新机 UI 重选

### 第 4 步：验证清单（重启 ZCode 后逐项过）

1. `/` 菜单：Commands 组出现 task-execute/task-review/swarm/brainstorm，Skills 组出现三个技能
2. 设置 → Subagents：coder / reviewer / researcher 出现
3. 设置 → MCP：glm-vision、glm-websearch 已连接；识一张图 + 搜一次词各测一发
4. `CreateWorkflow(saved: {name: "swarm", args: {dry_run: true, ...}})` 能跑通 dry_run
5. `quality-gate` 传一条 `{commands: [{tool: "node", args: ["--version"]}]}` 验证门禁链路
6. **成本路由**：在设置里为子代理重配默认模型绑定（源机的 agents-state 不随包迁移）→ 跑一次 swarm，看运行面板「子代理模型」或启动信息「Models named in the script」显示的是你绑的模型而非会话模型——机制复活确认

## 刻意不备份（安全考虑）

`~/.zcode/v2/provider_config.json`（供应商与 API key）、`agents-state.json`、`~/.zcode/cli/config.json`（含 MCP 的 key）不进入本目录，避免密钥随备份扩散；迁移时按上面第 2/3 步手动处理。

## 日常同步（源机改完资产后）

```bash
cp ~/.zcode/agents/*.md /d/Zcode/backup/agents/
cp -r ~/.zcode/skills/task-execute ~/.zcode/skills/task-review ~/.zcode/skills/brainstorming /d/Zcode/backup/skills/
cp ~/.zcode/commands/*.md /d/Zcode/backup/commands/
cp ~/.zcode/workflows/*.dwf.ts /d/Zcode/backup/workflows/
cp ~/.zcode/AGENTS.md /d/Zcode/backup/
```

建议把 D:\Zcode 整体纳入 git 或迁移前压缩归档一份。
