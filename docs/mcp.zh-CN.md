# D-message MCP 接口

客户端通过本地 `/mcp` 找到请求、读取消息、建立 Repeater 标签、修改草稿、检查差异，再选择发送给模型或原生 agent。页面和 MCP 共用标签、草稿、运行记录和队列。

## 对象和引用

| 对象 | 含义 | 引用 |
|---|---|---|
| 会话 | 同一客户端、同一 session ID 的请求组，标题可变 | `agent` 与 `session_id` 组合 |
| Trace | 捕获的一次模型请求与观测到的回应 | `trace:<uuid>` |
| Repeater 标签 | 可编辑的工作副本，保存来源、当前草稿、版本和重放记录 | `tab:<uuid>` |
| Run | 一次 **Send to model** 冻结的请求、选用的模型和回应 | `run:<uuid>` |
| Agent 交付记录 | 一次 **Send to agent** 的来源、目标、交付方式、回执和可用的原生会话 ID | `dispatch:<uuid>` |

`#2399` 等页面编号可直接用于查询，返回值总是包含稳定引用。标题只用于查找和显示。没有 session ID 的请求保持平铺。Trace 和 Run 均可作为新的 Repeater 来源。

## 工具

| 工具 | 输入及主要行为 |
|---|---|
| `recording` | `action=status/start/stop/configure`。返回录制状态、候选客户端、当前范围和捕获游标。配置复用页面的客户端增删与选择规则；开始录制返回的游标可直接用于跟踪后续请求。 |
| `trace_find` | 浏览、搜索或跟踪。`group_by=record/session`；按 `agent`、`session_id`、`status`、`kind=capture/replay`、页面编号或时间过滤。`query` 使用页面相同的 `request:`、`response:`、`tool:` 语义。默认最新优先并分页；显式 `after_capture` 切到按捕获顺序读取新请求，仅返回 capture。 |
| `trace_read` | 接受 `trace:` 或 `run:`。默认 `view=summary`；`turn` 读本轮新增内容，`messages` 分页读规范化消息块，`request`、`response` 读原协议 JSON，`recovered_output` 显式读取本机日志恢复的内容。`summary` 支持 `wait_ms` 短等待。 |
| `session_tree` | 用 `agent` 和 `session_id` 取得树，返回节点引用、父节点、本轮新增消息数、分支关系和活跃分支；支持 `active_only` 和向前分页。不传标题作为主键。 |
| `repeater_open` | 接受一个来源引用，打开或恢复对应的持久标签。显式 `duplicate=true` 建立独立实验。返回 `tab_ref`、`source_ref` 和当前 `revision`。同来源已有多个打开的标签时返回可选标签，不替用户挑选草稿。 |
| `repeater_tab` | `action=list/read/edit`。`read` 可选 `draft/changes/runs`；`changes` 返回当前请求草稿相对该标签最初来源的统一 diff。`edit` 接受 `revision` 和原子 JSON Patch，支持在消息数组中插入、替换、删除。成功后返回新版本；失败时不修改草稿。 |
| `repeater_models` | 返回页面同一份 Magpie 模型列表，包括可发送的模型 ID、显示名称和 provider 分组。 |
| `repeater_send_model` | 对应 **Send to model**。接受 `tab_ref`、`revision`、`request_key`，可选 `model`。默认使用草稿当前的模型，初始值为来源模型。按来源协议进入模型队列，返回 `run_ref`；模型返回的工具调用作为响应数据保存。 |
| `repeater_agent_options` | 只读。接受 `tab_ref`、`revision`，可选选中的 `run_ref`。复用页面的目标能力检查，返回原 agent、可选目标、各自的 `mode`、可用性和不可用原因。预检当前草稿，不启动客户端。 |
| `repeater_send_agent` | 对应 **Send to agent**。必须显式指定 `target_agent`、`mode` 和 `request_key`。`resend_prompt` 使用 `tab_ref + revision`；`continue_from_reply` 使用 `tab_ref + run_ref`。后端复核来源、版本和目标能力。返回 `dispatch_ref` 与可用的 `session_id`。 |
| `repeater_dispatch_status` | 按 `dispatch_ref` 查询原生 agent 的交付状态、错误及已有的工具回执。状态描述交付进度；只有能关联到新的捕获时才返回对应 Trace 引用。 |
| `repeater_cancel` | 接受 `run_ref`，只取消仍在模型队列中等待的运行。已提交的原生 agent 会话由对应客户端管理。 |

## 两种发送的边界

**Send to model** 适合测试“同一份请求换提示词或模型后，响应如何变化”。每次发送都是独立推理，遵循模型选择和八槽队列。返回的 `run_ref` 可以在 Repeater 查看完整请求和响应。

**Send to agent** 适合让原生客户端处理下一步。当前 Repeater 的目标有两种不同语义，MCP 将语义随目标一起返回：

| 方式 | 当前目标与前提 | 实际交付及回执 |
|---|---|---|
| `resend_prompt` | Codex、DSH、Claude Code；传入当前标签草稿版本即可。同客户端定位原生会话和修改点，跨客户端在目标新会话中发送当前用户消息。 | Codex 入队后打开桌面分支，DSH 向现有 Host 提交提示，Claude Code 启动后台任务。完成状态由目标客户端报告。 |
| `continue_from_reply` | Claude Code；需要选中属于该标签的、已完成且能交付给该目标的模型 Run。 | 将选中 Run 的已保存回答交付给新会话，由 Claude Code 从该回答继续。交付之后草稿的新编辑不会改变这个 Run。`delivered` 表示已送达，后续工具结果按实际回执显示。 |

两种发送都有各自的幂等记录。模型发送绑定草稿版本和实际模型；agent 发送绑定目标、方式以及对应的草稿版本或 Run 引用。同 key 重试返回原记录；一次模型发送永远不会因重试变成一次 agent 发送。交付失败时报告目标返回的原因，不自动换 agent、改用模型或重新创建分支。

## 读写约定

- 列表摘要包含页面编号、稳定引用、时间、agent、模型、协议、状态、最后一条消息预览、工具名称和最终回答预览。会话行增加本地名称及请求数。成功响应正文是否已捕获用 `has_response` 明示。
- 默认摘要通过元数据查询完成。正文按需读取，消息块附原始 JSON Pointer。搜索结果返回 `ref`、`side`、`path` 和短预览，客户端可以直接把 `side` 与 `path` 传给 `trace_read`。多个命中按页返回；超长字段返回截断标记和续读位置。用于修改的路径以该标签当前草稿为准。
- 失败只返回一个最终诊断 `failure`，可包含 provider、HTTP 状态、错误码、原因、消息和请求 ID。普通 Trace 与 Run 使用同一结构。无法唯一匹配的 Trace 保留未知原因；`trace_read` 观察既有补查，不因轮询重新发起账本查询。HTTP 200 的流内拒绝仍可表现为失败。
- `after_capture` 只跟踪新增捕获。等待已有请求或运行结束时用 `trace_read(view="summary",wait_ms=...)`；建议最大 5 秒。超时返回当前状态和 `terminal=false`，不改变任务状态。终态表示 D-message 已结束这轮处理；`unconfirmed` 仍表示模型结果未知。
- `revision` 同样约束页面编辑和 MCP 编辑。旧版本编辑或按草稿发送时返回 `revision_conflict` 及当前版本。发送到模型时在同一事务中检查版本、写入实际请求快照并入队。显式模型覆盖仅影响该次模型运行，并体现在 Run 的请求快照中。
- `request_key` 的重试按标签、版本、实际选用模型和请求快照识别。同一调用因网络中断重试应返回原 Run，即使标签后来有了新版本也不重复入队；相同 key 指向不同操作则返回 `idempotency_conflict`。
- 所有读取均使用本地既有权限。保留现有回环地址、可配置端口和 Bearer token。模型发送和 agent 发送分别出现在 MCP 客户端的工具授权列表中。agent 交付沿用页面已有的前提、原生权限及必要交互。清空 Trace 和管理凭据继续通过设置页操作。

## 典型调用

1. `trace_find(number=2399, kind="capture")` 获取该编号对应的 `trace_ref`。也可用 `trace_find(query="tool:shell_read")` 查到具体命中块。
2. `trace_read(ref=trace_ref, view="turn")` 查看本轮消息及其原始路径。
3. `repeater_open(source_ref=trace_ref)` 获取 `tab_ref` 与版本；`repeater_tab(action="edit", tab_ref, revision, ops)` 修改目标块。
4. `repeater_tab(action="read", tab_ref, view="changes")` 检查请求 diff。
5. 如果目的是看模型回应，调用 `repeater_send_model(tab_ref, revision, request_key="model-1")`，用 `trace_read(ref=run_ref)` 读取结果。
6. 如果目的是让 DSH 重答，先查询 `repeater_agent_options(tab_ref, revision)`；该目标可用时直接调用 `repeater_send_agent(tab_ref, revision, target_agent="dsh", mode="resend_prompt", request_key="agent-1")`。无需先执行第 5 步。
7. Claude Code 也支持直接指定当前草稿 revision，使用 `resend_prompt` 启动后台会话。兼容旧流程时，如果明确要把第 5 步选定的回答交给 Claude Code，查询该 Run 的目标选项，再调用 `repeater_send_agent(tab_ref, run_ref, target_agent="claude", mode="continue_from_reply", request_key="agent-2")`。用 `repeater_dispatch_status(dispatch_ref)` 查交付回执。

## 分期与验收

1. **读取与搜索。** 先实现 `trace_find`、`trace_read` 和 `session_tree`，共用页面的状态、标题、搜索与树逻辑。验收包括正常完成但无正文、流内拒绝、无法匹配、Codex 恢复输出和无 session ID 的请求。
2. **可见的 Repeater 工作流。** 接入标签、草稿、diff、模型队列与原生 agent 交付。分别验收两种发送：模型发送可选模型、可取消排队；agent 发送命中正确分支或交付选中的回答，重试不重复提交提示。两者都记录在对应标签，按类型展示。过期草稿不覆盖新内容，重启后能恢复标签和回执。
3. **连接。** 使用原端口、已有 Bearer token 和 `/mcp`。重新发现工具后使用本文接口。
