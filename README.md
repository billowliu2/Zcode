# Zcode — ZCode 自定义 AI 工作体系仓库

本仓库是 ZCode 客户端自定义配置的**资产仓库**，包含三部分：自定义资产（子代理/技能/命令/工作流）的备份与迁移包、三个自建 MCP 服务器、体系说明文档。

生效位置在本仓库之外——ZCode 从 `C:\Users\<用户名>\.zcode\` 读取配置。把本仓库铺到新电脑的完整步骤见 [backup/README.md](backup/README.md)。

## 目录结构

| 目录 | 内容 | 详细文档 |
|---|---|---|
| `backup/` | 自定义资产备份 + 迁移指南：`agents/`（coder、reviewer、researcher 三个子代理）、`skills/`（task-execute、task-review、brainstorming）、`commands/`（6 个斜杠命令）、`workflows/`（swarm 等保存工作流）、`AGENTS.md`（用户级全局工作约定）；`backup/mcp/` 是三个 MCP 服务器的快照副本 | [backup/README.md](backup/README.md) |
| `mcp/glm-codegraph/` | 代码知识图谱 MCP：tree-sitter 解析项目 → 每项目一个 SQLite 符号图谱，提供 codegraph_find / impact / context / overview / cleanup 五个工具 | [mcp/glm-codegraph/README.md](mcp/glm-codegraph/README.md) |
| `mcp/glm-vision/` | 识图 MCP：本地图片与剪贴板图像 → 视觉模型分析（API 地址与密钥经 MCP env 注入，不入库） | — |
| `mcp/glm-websearch/` | 联网搜索 MCP：Bing → AnySearch → Exa → Parallel 四引擎免 key 自动降级链 | — |
| `docs/` | 体系文档：《ZCode自定义AI工作体系说明.pdf》及其构建脚本 `_build_manual.py` | — |

## 快速上手

- **迁移到新电脑**：按 [backup/README.md](backup/README.md) 四步执行（铺资产到 `~/.zcode` → 注册 MCP → 手动迁供应商/模型配置 → 逐项验证）
- **codegraph 首次使用**：进入 `mcp/glm-codegraph/` 执行一次 `npm install`（需 Node ≥ 22.18；`node_modules/` 不入库）

## 本仓库的 git 约定

- **推送凭据**：令牌放在本地 `.env` 的 `GIT_TOKEN`，仓库已配置 credential helper 自动读取（模板见 `.env.example`）
- **不入库**（见 `.gitignore`）：`.env`（密钥）、`mcp/glm-codegraph/node_modules/`（npm 依赖，可用 package-lock.json 还原）、`mcp/glm-codegraph/data/`（各项目生成的 sqlite 图谱缓存）
