# Runtime Inspection Visibility Design

## 背景

用户反馈 Runtime 运行时像黑盒：不知道拆出了几个任务、每个任务等级是什么、验收结果是什么、验收失败后是否发生升级处理。现有数据已经记录在 run、report、events、workerAttempts、verification、routingTrace 中，但 `status` 太简略，`run --json` 太庞杂，`report --markdown` 更像事后审计，不适合运行中观察。

## 目标

新增一个共享 inspection 能力，让 CLI、MCP、HTTP 都能展示同一份“运行观察面板”。面向人的文本输出使用中文，结构化 JSON 保留既有英文属性名以便工具集成。

## 设计

新增 `src/runtime/inspection.js`，导出：

- `createRunInspection(record)`：从 run record 生成稳定 JSON。
- `formatInspectionMarkdown(inspection)`：生成中文可读输出。

Inspection 输出聚焦以下问题：

- Runtime 拆了几个任务。
- 每个任务的 `difficulty`、`risk`、`modelTier`、provider/model、路由原因是什么。
- 每个任务当前状态：等待、跳过、记录、已应用、失败、最终审查任务。
- 每个任务的验收状态和验收条目通过情况。
- worker 尝试次数、失败原因、触达文件。
- 是否发生升级：从哪个 tier/model 升到哪个 tier/model，原因是什么。
- 最新验证状态、命令检查、验收检查、最终 supervisor review、验证失败后的升级建议。
- 下一步动作，例如需要审批、可以执行、需要修复验证失败、需要查看失败任务。

## 接入面

- CLI：新增 `ai-coding-runtime inspect <run-id> [--json]`。
- MCP：新增 `runtime_inspect`。
- HTTP：新增 `GET /api/runs/:id/inspect`。
- Report：修复 markdown 中 selected model 显示 `[object Object]` 的问题，但 report 不作为主观察入口。

## 非目标

- 不做网页 UI 或 TUI。
- 不改变路由、执行、验证、升级策略。
- 不让 learning shadow recommendation 影响实时路由。
- 不修改 provider 调用协议。

## 验收标准

- planned run 的 inspect 能显示任务数量、任务等级、模型层级、路由原因、下一步。
- 有 worker attempt 的 run 能显示任务执行状态、触达文件、验收证据。
- worker 失败后升级的 run 能显示升级链路。
- verification failed 的 run 能显示验收/命令/最终审查/升级摘要。
- CLI 默认中文输出，`--json` 输出结构化 JSON。
- MCP 和 HTTP 返回同一份结构化 inspection。
- `npm test` 通过。
