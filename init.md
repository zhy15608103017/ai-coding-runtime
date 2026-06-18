# 设计多模型任务分流

> 我现在有一个想法，就是我在使用ai编程工具的时候，在我输出自己的要求后，主模型大模型自动拆分任务，并对任务分析出任务难度。根据任务难度在指派给子模型运行，最后子模型运行的结果交由主模型，让他完成最终校验，这个需求的原因是，现在顶尖模型价格昂贵，而不是所有的任务都必须使用这么顶级的模型，某些任务可以用能力稍微低的模型去替代，你觉得我该怎么设计，他应该作为什么存在，方便使用

<details><summary>4 previous messages</summary>

> 我会用 `superpowers:using-superpowers` 和 `superpowers:brainstorming` 来处理这个设计问题：先遵循技能流程，再把你的想法拆成可落地的产品/架构形态。
>
> 我先快速看一下这个仓库现在怎么组织 skills 和脚本，这样建议会更贴近你已有的 `generalSkills` 生态，而不是飘在空中的架构图。
>
> 我看到这个仓库已经是“可安装的通用 skills + 生成/安装脚本”的形态，所以这个想法很适合先做成一个可复用的编排 skill，再视使用频率升级成更强的工具层。接下来我看一下现有 skill 的写法和 CLI 边界。
>
> 上下文已经够清楚了：你这个仓库最自然的落点不是先做一个完整平台，而是先沉淀成“模型路由/任务编排”能力，再逐步工具化。我先给你一个可执行的设计判断。
</details>

我觉得你的想法很对，本质上它不是“子模型功能”，而应该设计成一个 **AI 编程任务编排层**。名字可以叫：

**Model Router / Agent Orchestrator / 成本感知任务调度器**

它的职责不是替代主模型，而是让主模型只做最值钱的事：理解需求、拆任务、定标准、最终验收。中间那些低风险、低创造性、可验证的工作，交给便宜模型或小模型。

**我推荐的存在形态：先做成 Skill，再升级成 MCP/CLI 工具。**

在你这个 `generalSkills` 仓库里，最适合先做一个：

```text
skills/cost-aware-agent-orchestrator/
  SKILL.md
  references/routing-policy.md
  references/task-contract.md
  references/model-tiers.md
  scripts/estimate-task.mjs
```

这样它可以立刻被 Codex、Claude Code、Cursor、Gemini、Windsurf 等工具复用。等策略稳定后，再把核心能力抽出来做成 MCP server 或 CLI，让不同 AI 编程工具都能调用。

**核心流程可以这样设计：**

```text
用户需求
  ↓
主模型理解需求
  ↓
拆分任务 DAG
  ↓
给每个任务打分：难度 / 风险 / 上下文需求 / 可验证性
  ↓
选择模型等级
  ↓
子模型执行
  ↓
收集结果、diff、测试输出、解释
  ↓
主模型最终校验
  ↓
交付
```

关键点是：不要只按“难度”分配模型，而要按 **风险 + 可验证性 + 上下文复杂度** 分配。

比如：

| 任务类型 | 推荐模型 |
| --- | --- |
| 搜索文件、总结代码、提取信息 | 便宜模型 |
| 写简单测试、改文案、生成重复代码 | 中低模型 |
| 小型 bug fix、局部 refactor | 中等模型 |
| 架构设计、跨模块修改、安全/数据相关代码 | 顶级模型 |
| 最终验收、需求一致性检查 | 顶级模型 |

我会把任务等级设计成这样：

```text
L0: 只读任务，比如搜索、总结、列清单
L1: 低风险生成，比如文档、注释、简单测试
L2: 局部代码修改，有测试可验证
L3: 跨文件/跨模块修改，需要较强推理
L4: 架构、安全、数据迁移、复杂 bug，必须顶级模型
```

每个子任务都应该有一个标准格式，避免子模型自由发挥：

```yaml
id: task-003
goal: 为 install-skills 增加边界测试
risk: low
difficulty: L1
allowed_files:
  - tests/install-skills.test.mjs
forbidden_actions:
  - 修改 CLI 行为
expected_output:
  - patch
  - verification command
  - concise explanation
acceptance:
  - npm test passes
  - existing behavior unchanged
```

这样主模型最后不是“相信子模型”，而是根据 contract 验收它。

**我建议分三层做：**

第一层：**Skill 形态**
适合现在就放进你的仓库。它告诉主模型怎么拆任务、怎么打分、怎么选择模型、怎么验收。优点是轻、通用、马上能用。

第二层：**脚本辅助**
比如 `estimate-task.mjs` 根据任务描述输出建议等级和模型档位。这样不同 AI 工具即使没有强工具调用能力，也能获得一致策略。

第三层：**MCP / 本地调度服务**
当你想真正自动调用不同模型 API 时，再做 MCP。它可以暴露类似：

```text
delegate_task(task, modelTier, files, constraints)
estimate_task(task)
collect_result(taskId)
```

这时主模型只需要调用工具，工具负责找便宜模型、跑任务、回收结果。

**我的推荐路线：**

先不要一上来做完整平台。先在 `generalSkills` 里做一个 **cost-aware-agent-orchestrator skill**，把“怎么拆、怎么评估、怎么分配、怎么验收”标准化。
当这个 skill 在真实编程流程里跑顺了，再把其中稳定的部分升级成 MCP server。这样不会过早绑定某个工具，也符合你这个仓库“通用 skills”的定位。

最关键的一个选择是：你希望它一开始是 **指导主模型工作的规则 skill**，还是一开始就要 **真的自动调用不同模型 API 的调度工具**？我建议先选前者，成本最低，迭代最快。

> 你觉得他最终是一个什么模式，不考虑现在代码仓库的影响

<details><summary>1 previous message</summary>

> 我继续按 `superpowers:brainstorming` 来回答，不过这次不落到当前仓库实现，只讨论它最终应当成为一种什么产品/系统模式。
</details>

我觉得它最终不应该只是一个 prompt、skill 或插件，而应该是一个 **AI 编程代理的调度运行时**。

更准确地说：

**它最终应该是一个“成本感知的 Agent Orchestrator + Model Gateway”。**

也就是一个夹在“AI 编程工具”和“各种模型 API”之间的中间层。

```text
用户
  ↓
Codex / Claude Code / Cursor / Trae / Windsurf
  ↓
Agent Orchestrator 调度层
  ↓
任务拆分 / 难度评估 / 风险评估 / 模型路由
  ↓
不同等级模型执行子任务
  ↓
主模型验收 / 测试 / 汇总
  ↓
最终结果
```

它的最终形态我会设计成三部分：

**1. 本地常驻调度服务**

类似一个本地 daemon。它知道你的项目、预算、可用模型、任务历史、模型表现。AI 编程工具不用直接决定调用哪个模型，而是把任务交给它。

它负责：

```text
拆任务
评估难度
评估风险
选择模型
控制预算
分发子任务
收集结果
触发验证
形成最终交付材料
```

**2. 多工具接入协议**

它不应该绑定某一个 AI 编程工具。最好的方式是提供：

```text
MCP Server
CLI
HTTP API
IDE 插件适配层
```

这样 Codex、Claude Code、Cursor、Trae、Windsurf、Gemini CLI 都能接进来。

最终用户体验应该是：用户仍然在自己喜欢的 AI 编程工具里正常输入需求，但背后由这个调度层决定“谁来干活”。

**3. 模型网关**

它还应该像一个智能模型代理层，统一管理：

```text
OpenAI
Anthropic
Gemini
DeepSeek
Qwen
本地模型
公司内部模型
```

但它不是简单负载均衡，而是根据任务类型路由。

比如：

```text
只读分析 → 便宜模型
生成测试 → 中等模型
局部代码修改 → 中等或强模型
架构设计 → 顶级模型
安全/支付/数据迁移 → 顶级模型
最终验收 → 顶级模型
```

所以它的核心价值不是“多模型调用”，而是 **用最低成本达到足够可靠的结果**。

我会把它定义成一种新模式：

**Supervisor-Worker Coding Mode**

也就是：

```text
Supervisor 主模型：理解、规划、约束、验收
Worker 子模型：执行明确、可验证、低到中风险任务
Router 调度器：决定任务给谁、花多少钱、失败后怎么升级
Verifier 校验器：跑测试、审 diff、检查需求一致性
```

这里最关键的是：低级模型不能自由发挥，它只能处理被主模型包装过的“任务合同”。

每个任务都要长这样：

```yaml
task_id: fix-test-001
goal: 为用户登录逻辑补充边界测试
risk: low
allowed_files:
  - tests/auth.test.ts
forbidden:
  - 修改生产代码
  - 改变接口行为
model_tier: cheap
acceptance:
  - 测试覆盖空密码
  - 测试覆盖不存在用户
  - npm test 通过
```

这样子模型不是“另一个聊天机器人”，而是一个被约束的执行器。

我认为它最终的产品形态应该叫：

**AI Coding Runtime**

或者中文一点：

**智能编程调度内核**

它不是 IDE，不是聊天工具，也不是单纯的模型代理。它更像 AI 编程时代的任务运行环境。

最理想的使用方式是：

```bash
ai-runtime start
```

然后任何 AI 编程工具都可以连接它：

```text
Codex 使用它
Claude Code 使用它
Cursor 使用它
CI 使用它
本地脚本也能使用它
```

用户层面只感知三个东西：

```text
更便宜
更快
更稳
```

开发者层面可以看到：

```text
任务被拆成了哪些
每个任务用了哪个模型
花了多少钱
为什么升级到强模型
哪些子任务失败了
最终验收依据是什么
```

所以我的判断是：

**短期它可以是 skill / 插件。中期它应该是 MCP server。最终它应该是一个本地优先、可接多模型、多工具的 AI Coding Runtime。**

这东西真正有价值的地方不是“能调便宜模型”，而是建立一套可信的任务分级和验收机制。没有验收机制，它只是省钱；有了验收机制，它才是生产力系统。

> 现在让我们以最终目标AI Coding Runtime作为任务，设计出最初框架，在慢慢完善他

<details><summary>1 previous message</summary>

> 我会继续用 `superpowers:brainstorming`，但这次把范围固定为“AI Coding Runtime 的最初框架设计”，不绑定现有仓库和代码实现。
</details>

可以。我们先把它当成一个真正产品来设计，而不是某个插件。

我的建议：**AI Coding Runtime 的最初框架应该从“本地调度内核”开始，而不是从完整平台开始。**

**核心定位**

它是一个运行在本地或团队内网的 AI 编程任务运行时，负责把用户的大需求变成可执行、可验证、可计费、可追踪的任务流。

```text
AI Coding Tool
  ↓
AI Coding Runtime
  ↓
Planner / Router / Executor / Verifier
  ↓
Models + Tools + Codebase
```

它最终不是聊天界面，而是 **编程任务的操作系统层**。

**我推荐的 V0 框架**

```text
AI Coding Runtime
├─ Gateway 接入层
├─ Task Planner 任务规划器
├─ Task Classifier 难度/风险评估器
├─ Model Router 模型路由器
├─ Worker Executor 子任务执行器
├─ Context Manager 上下文管理器
├─ Verification Engine 验证引擎
├─ Memory & Trace 记忆与审计
└─ Policy Engine 策略引擎
```

每一层职责如下。

**Gateway 接入层**

负责接入外部 AI 编程工具。

第一阶段支持：

```text
CLI
MCP Server
HTTP API
```

长期再支持 IDE 插件。这样它不依赖 Codex、Claude Code、Cursor 任何单一工具。

**Task Planner 任务规划器**

主模型或强模型负责把用户需求拆成任务 DAG：

```text
需求
  → 读取代码结构
  → 设计方案
  → 修改模块 A
  → 修改模块 B
  → 补测试
  → 跑验证
  → 最终审查
```

重点是任务之间有依赖关系，而不是简单列表。

**Task Classifier 难度/风险评估器**

每个任务都打分：

```text
difficulty: L0-L4
risk: low / medium / high
context_need: low / medium / high
verification: easy / medium / hard
```

不要只看难度。真正决定模型等级的是：

```text
风险 × 上下文复杂度 × 可验证性
```

**Model Router 模型路由器**

根据任务评级选择模型。

```text
L0 只读总结 → cheap model
L1 文档/测试/简单生成 → cheap 或 mid model
L2 局部代码修改 → mid model
L3 跨模块修改 → strong model
L4 架构/安全/高风险 → top model
final verification → top model
```

这里要允许自动升级：便宜模型失败、结果不可信、测试失败，就升级到更强模型。

**Worker Executor 子任务执行器**

子模型不能自由聊天，它只执行任务合同。

```yaml
task_id: T-004
goal: add tests for auth validation
allowed_files:
  - tests/auth.test.ts
forbidden_actions:
  - modify production auth logic
model_tier: cheap
acceptance:
  - covers empty password
  - covers invalid email
  - test command passes
output:
  - patch
  - explanation
  - verification result
```

这点很关键。**Worker 是受约束执行器，不是副驾驶。**

**Context Manager 上下文管理器**

负责给每个子任务提供刚好够用的上下文。

```text
项目摘要
相关文件
接口定义
约束规则
测试命令
任务合同
```

它要避免把整个项目塞给便宜模型，既贵又容易乱。

**Verification Engine 验证引擎**

负责验证，而不是相信模型。

第一阶段最少支持：

```text
git diff check
lint
typecheck
unit tests
task acceptance check
final review
```

长期可以支持：

```text
AI code review
安全扫描
性能回归检查
需求一致性审计
```

**Memory & Trace 记忆与审计**

每次运行都记录：

```text
任务如何拆分
每个任务用了哪个模型
花了多少钱
输入输出摘要
为什么升级模型
验证结果
最终 diff
```

这是这个系统从“省钱工具”变成“可靠工程系统”的关键。

**Policy Engine 策略引擎**

用户或团队可以配置规则：

```yaml
budget:
  max_cost_per_run: 2.00
  prefer_cheap_models: true

routing:
  final_review_model: top
  security_tasks_min_tier: strong
  allow_local_models_for_readonly: true

safety:
  require_tests_for_code_changes: true
  require_human_approval_for_high_risk: true
```

**V0 最小闭环**

最初版本不要做太大。我建议只实现这个闭环：

```text
接收用户需求
  ↓
规划任务
  ↓
给任务分级
  ↓
生成任务合同
  ↓
选择模型等级
  ↓
执行子任务
  ↓
收集结果
  ↓
运行验证
  ↓
主模型最终审查
  ↓
输出报告
```

V0 可以先只支持 3 类模型：

```text
cheap
standard
premium
```

不要一开始支持几十个模型，先把调度逻辑跑通。

**我对最终模式的判断**

它应该采用：

```text
Supervisor + Router + Workers + Verifier
```

而不是单 Agent 模式。

其中：

```text
Supervisor：主模型，负责理解、规划、最终验收
Router：调度器，负责分级、预算、模型选择
Workers：子模型，负责执行受约束任务
Verifier：验证器，负责测试、审查、需求一致性
```

第一版框架可以先做成一个本地服务：

```bash
ai-coding-runtime start
```

然后暴露：

```text
MCP: 给 AI 编程工具用
CLI: 给用户和脚本用
HTTP: 给后续平台或 Web UI 用
```

我建议我们下一步先确定 **V0 的边界**：第一版是只做“任务规划 + 模型路由 + 执行记录”，还是直接包含“真实调用子模型并修改代码”的完整闭环？

Forked conversation

Source conversation: 019ed4a0-d9c7-7651-8e8e-aa06454f0bd8

> 他是怎么使用得了，比如我在codex桌面端怎么使用它，在codex cil怎么使用他在opencode和cursor中怎么使用

<details><summary>4 previous messages</summary>

> 我会同时用 `openai-docs` 和 `superpowers:brainstorming`：前者帮我避免把 Codex 接入方式说偏，后者用来把“不同工具怎么使用 Runtime”设计成统一产品体验。
>
> <details><summary>Ran 2 commands</summary>
>
> - Ran `Get-Content -Raw C:\Users\Administrator\.codex\skills\.system\openai-docs\SKILL.md`
> - Ran `Get-Content -Raw C:\Users\Administrator\.codex\superpowers\skills\brainstorming\SKILL.md`
>
> </details>
>
> 我先确认一下 Codex 当前公开手册里对 MCP、CLI、桌面端这些接入面的说法；这些接口形态变化会比较快，设计时不能靠旧印象。
>
> <details><summary>Ran a command, searched the web</summary>
>
> - Ran `node C:\Users\Administrator\.codex\skills\.system\openai-docs\scripts\fetch-codex-manual.mjs`
>
> <details><summary>Searched the web</summary>
>
> - Searched the web for `site:developers.openai.com/codex MCP Codex config.toml MCP server Codex CLI`
> - Searched the web for `opencode MCP server configuration official docs`
> - Searched the web for `https://developers.openai.com/codex/mcp`
> - Searched the web for `site:cursor.com/docs mcp.json Cursor MCP server command args`
> - Searched the web for `https://cursor.com/docs/mcp.md`
> - Searched the web for `https://opencode.ai/docs/config/`
> - Searched the web for `https://developers.openai.com/codex/learn/best-practices`
> - Searched the web for `'codex mcp add' in https://developers.openai.com/codex/mcp`
>
> </details>
>
> </details>
</details>

最理想的使用方式是：**你不用换 AI 编程工具，只是给这些工具装上同一个 Runtime 入口**。

它对外应该暴露成：

```text
1. MCP Server：给 Codex / Cursor / OpenCode 调用
2. CLI：给人和脚本调用
3. HTTP API：给后续桌面端、Web UI、团队平台调用
4. Skill / Rule：告诉不同工具什么时候该调用它
```

**核心用法**

你先启动 Runtime：

```bash
ai-coding-runtime start
```

它本地提供：

```text
http://localhost:3847/mcp
http://localhost:3847/api
```

然后 Codex、Cursor、OpenCode 不是直接替换自己的模型，而是把它当成一个“高级工具”：

```text
用户对 Codex/Cursor/OpenCode 说需求
  ↓
主模型判断任务复杂
  ↓
调用 ai-coding-runtime.plan
  ↓
Runtime 拆任务、估价、选模型、执行子任务
  ↓
返回结果、diff、验证报告
  ↓
主模型最终确认
```

也就是说，第一版它不是“替换 Codex/Cursor 的大脑”，而是成为它们都能调用的 **外部编程调度器**。

**在 Codex 桌面端**

Codex 最自然的方式是 MCP + Skill/Plugin。

用法大概是：

```text
Codex App
  → Settings
  → MCP servers
  → Add server
  → URL: http://localhost:3847/mcp
```

然后再配一个 skill，告诉 Codex：

```text
当任务需要拆分、成本控制、多模型执行、最终校验时，
先调用 ai-coding-runtime 的 plan/estimate/run 工具。
```

你在 Codex 桌面端里就可以这样说：

```text
用 AI Coding Runtime 处理这个需求。
先拆任务、估算成本和风险，等我确认后再执行。
```

或者更自然一点：

```text
这个任务比较大，走 runtime 模式，优先省 token，但最终验收用强模型。
```

Codex 官方文档里，MCP 是连接外部工具和上下文的方式，Codex App 里也可以在 Settings → MCP servers 管理 MCP；Codex 的 skills 也适合把重复工作流程固化下来。Codex 的 CLI、IDE、App 共享配置层，这是我们做“一次配置，多处使用”的基础。参考：[Codex MCP](https://developers.openai.com/codex/mcp)、[Codex best practices](https://developers.openai.com/codex/learn/best-practices)。

**在 Codex CLI**

Codex CLI 里可以直接加 MCP：

```bash
codex mcp add ai-coding-runtime -- npx -y ai-coding-runtime mcp
```

或者在 `~/.codex/config.toml` / 项目 `.codex/config.toml` 里配置远程 HTTP MCP：

```toml
[mcp_servers.ai_coding_runtime]
url = "http://localhost:3847/mcp"
enabled = true
default_tools_approval_mode = "prompt"
```

之后在 CLI 里：

```bash
codex
```

然后输入：

```text
使用 ai-coding-runtime 规划并执行这个任务：把支付模块重构为可测试结构。
要求先给我任务拆分、风险等级和预计成本。
```

Codex TUI 里还可以用 `/mcp` 查看当前可用 MCP 服务。官方文档也说明 Codex 支持 STDIO 和 Streamable HTTP MCP，CLI 可以用 `codex mcp` 管理服务。参考：[Codex MCP 配置](https://developers.openai.com/codex/mcp)。

**在 OpenCode**

OpenCode 也适合走 MCP。项目里放 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "remote",
      "url": "http://localhost:3847/mcp",
      "enabled": true
    }
  }
}
```

如果用本地 stdio：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai_runtime": {
      "type": "local",
      "command": ["npx", "-y", "ai-coding-runtime", "mcp"],
      "enabled": true
    }
  }
}
```

使用时直接说：

```text
use ai_runtime to split this feature into subtasks, route cheap tasks to small models, and return a verified patch
```

更好的体验是给 OpenCode 加一个 command：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "command": {
    "runtime": {
      "template": "Use ai_runtime to plan, route, execute, verify, and summarize this task: $ARGUMENTS",
      "description": "Run task through AI Coding Runtime"
    }
  }
}
```

之后你就可以类似这样用：

```text
/runtime 重构用户权限模块，并尽量降低模型成本
```

OpenCode 官方支持本地/远程 MCP，并且 MCP 工具会和内置工具一起提供给模型；它也支持自定义 commands、agents、plugins。参考：[OpenCode MCP servers](https://opencode.ai/docs/mcp-servers)、[OpenCode config](https://opencode.ai/docs/config/)。

**在 Cursor**

Cursor 最自然也是 MCP + Rules / Skills。

项目级配置：

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

或者本地 stdio：

```json
{
  "mcpServers": {
    "ai-coding-runtime": {
      "command": "npx",
      "args": ["-y", "ai-coding-runtime", "mcp"]
    }
  }
}
```

然后加一个 Cursor rule：

```md
---
description: Use AI Coding Runtime for complex coding tasks that benefit from task splitting, model routing, cost control, or final verification.
alwaysApply: false
---

When a task is multi-step, high-cost, or needs verification, call the ai-coding-runtime MCP tools first:
1. plan the task
2. estimate risk and cost
3. ask user approval if risk is medium or high
4. run delegated subtasks
5. verify final result before presenting changes
```

你在 Cursor Agent 里就可以说：

```text
Use AI Coding Runtime for this change. Optimize for cost, but require premium final review.
```

Cursor 支持 `.cursor/mcp.json` / `~/.cursor/mcp.json`，也支持 stdio、SSE、Streamable HTTP，并且 Agent 会在相关时自动使用可用 MCP 工具；Cursor Rules 和 Agent Skills 则适合把“什么时候使用 Runtime”固化下来。参考：[Cursor MCP](https://cursor.com/docs/mcp.md)、[Cursor Rules](https://cursor.com/docs/rules.md)、[Cursor Skills](https://cursor.com/docs/skills.md)。

**我建议的真实产品体验**

最终你应该提供四种入口：

```bash
ai-coding-runtime start
ai-coding-runtime mcp
ai-coding-runtime run "实现登录限流"
ai-coding-runtime report <run-id>
```

同时 MCP 暴露这些工具：

```text
runtime_plan
runtime_estimate
runtime_run
runtime_status
runtime_collect
runtime_verify
runtime_report
runtime_cancel
```

用户不需要理解细节。用户只需要在任意工具里说：

```text
用 runtime 模式处理这个任务。
```

背后发生的是：

```text
当前 AI 工具 = Supervisor
AI Coding Runtime = Router + Executor + Verifier
便宜/中等/顶级模型 = Workers
```

最重要的一点：**第一阶段不要试图替换 Codex、Cursor、OpenCode 的主模型。**
先让 Runtime 作为 MCP 调度工具存在。这样接入最简单、兼容性最好、产品阻力最低。等它成熟后，再做自己的 CLI/桌面端，变成真正完整的 AI Coding Runtime。
