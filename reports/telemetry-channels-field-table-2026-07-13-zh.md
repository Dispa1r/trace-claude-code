# Claude Code 遥测通道字段对照表

日期：2026-07-13

范围：
- [claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)
- [/Users/luyiren/unbuned/output/claude/resplit](/Users/luyiren/unbuned/output/claude/resplit)

## 总结

当前版本（2.1.204）里，这三条链路都还存在，但状态略有差别：

1. **Datadog**
   - 还在
   - 精确 intake 端点还能直接命中

2. **1P Event Logging**
   - 还在
   - 当前静态命中的是 `/api/event_logging/v2/batch`
   - 比“旧的 `/api/event_logging/batch`”多了 `v2`

3. **GrowthBook**
   - 还在
   - feature flag / experiment / refresh hook 都能命中
   - 但当前可读 JS 里没有直接恢复出一个明确的 GrowthBook HTTP URL 常量

---

## 1. Datadog

### 当前状态

存在，且静态可直接命中精确上报端点。

### 端点

- `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`
  - 证据：[resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)

### 启用条件

- Datadog sink 初始化：
  - [resplit/4637.js](/Users/luyiren/unbuned/output/claude/resplit/4637.js:2)
    - `initializeAnalyticsSink`
    - `shouldTrackDatadog`

- 关键开关：
  - `tengu_log_datadog_events`
    - [resplit/4637.js](/Users/luyiren/unbuned/output/claude/resplit/4637.js:2)

- 只在 first-party provider 下发送：
  - [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
    - `if(wn()!=="firstParty") return;`

### 载荷结构

Datadog 这一层最终会组一个日志对象，大体结构如下：

- 固定字段：
  - `ddsource: "nodejs"`
  - `message: <event_name>`
  - `service: "claude-code"`
  - `hostname: "claude-code"`
  - `env: "external"`
  - `ddtags: ...`

- 事件名：
  - 来自 `N(...)` / `Nb(...)` 这类上层事件名，例如 `tengu_*`

- 通用元数据来源：
  - `YHn(...)`
  - `lBl(...)`
  - 事件调用方传入的 `event_metadata`

### 主要字段类别

#### A. Core / 会话级字段

来自 [resplit/1518.js](/Users/luyiren/unbuned/output/claude/resplit/1518.js:2) 的 `YHn(...)`：

- `model`
- `sessionId`
- `userType`
- `betas`
- `entrypoint`
- `sessionKind`
- `hasAttacher`
- `agentSdkVersion`
- `isInteractive`
- `clientType`
- `processMetrics`
- `sweBenchRunId`
- `sweBenchInstanceId`
- `sweBenchTaskId`
- `agentId`
- `parentSessionId`
- `agentType`
- `teamName`
- `subscriptionType`
- `rh`
- `head_sha`
- `rendererMode`

#### B. Env / 运行环境字段

来自 [resplit/1518.js](/Users/luyiren/unbuned/output/claude/resplit/1518.js:2) 的 `lBl(...)`：

- `platform`
- `platform_raw`
- `arch`
- `node_version`
- `terminal`
- `shell`
- `package_managers`
- `runtimes`
- `is_running_with_bun`
- `is_ci`
- `is_claubbit`
- `is_claude_code_remote`
- `is_local_agent_mode`
- `is_conductor`
- `is_github_action`
- `is_claude_code_action`
- `is_claude_ai_auth`
- `version`
- `build_time`
- `deployment_environment`

可选扩展：

- `remote_environment_type`
- `claude_code_container_id`
- `claude_code_remote_session_id`
- `tags`
- `github_event_name`
- `github_actions_runner_environment`
- `github_actions_runner_os`
- `github_action_ref`
- `wsl_version`
- `linux_distro_id`
- `linux_distro_version`
- `linux_kernel`
- `vcs`
- `version_base`

#### C. Auth / 身份字段

来自 `lBl(...)`：

- `account_uuid`
- `organization_uuid`

#### D. 事件附加字段

来自具体事件调用处的 `event_metadata`，例如：

- `toolName`
- `status`
- `querySource`
- `requestId`
- `permissionMode`
- `gateway`
- `fastMode`
- 各种产品事件自带字段

#### E. 特殊规范化

在 Datadog sink 里还能看到一些专门处理：

- `toolName` 如果是 `mcp__...`，会归一化成 `mcp`
- `status` 会拆成：
  - `http_status`
  - `http_status_range`
- `model` 会被归一化到 Claude 模型族
- `version` 会去掉 dev 构建时间尾巴

### 结论

Datadog 这条链不是只发一个事件名，而是会带上大量会话、环境、身份和事件附加字段。

---

## 2. 1P Event Logging

### 当前状态

存在，并且是当前代码里很完整的一条事件日志链。

### 端点

当前静态命中的是：

- `/api/event_logging/v2/batch`
  - 证据：[resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)

最终会拼成：

- `https://api.anthropic.com/api/event_logging/v2/batch`
  或
- `ANTHROPIC_BASE_URL + /api/event_logging/v2/batch`

### 初始化与生命周期

- 初始化：
  - [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
    - `initialize1PEventLogging`

- 动态重载：
  - [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
    - `reinitialize1PEventLoggingIfConfigChanged`

- 启动调用点：
  - [resplit/6178.js](/Users/luyiren/unbuned/output/claude/resplit/6178.js:4)
  - [resplit/5476.js](/Users/luyiren/unbuned/output/claude/resplit/5476.js:2)

### 是否带认证

这条链支持带第一方认证头，但不是“绝对只有 OAuth 才能发”。

从 [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2) 的 `sendBatchWithRetry(...)` 看：

- 会优先尝试带认证头
- trust / token 状态不满足时，会走无认证或降级分支
- 401 时还会尝试另一条 fallback

所以更准确的描述是：

> 这条链支持第一方认证上报，但实际是否带 auth 取决于当前 trust / token / 配置状态。

### 事件类型

当前静态能明确恢复出两类：

#### A. `ClaudeCodeInternalEvent`

这是普通内部事件的主类型。

构造位置：

- [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
  - `transformLogsToEvents(...)`

字段包括：

- `event_id`
- `event_name`
- `client_timestamp`
- `device_id`
- `email`
- `auth`
- `core`
- `env`
- `process`
- `skill_name`
- `plugin_name`
- `marketplace_name`
- `repl_code`
- `head_sha`
- `additional_metadata`

其中：

- `core` / `env` / `auth` 来自 `lBl(...)`
- `additional_metadata` 是经过筛选和 base64 编码后的剩余事件字段

#### B. `GrowthbookExperimentEvent`

这类实验事件会通过 1P channel 单独发送，见下一节。

### 队列 / 重试 / 落盘

1P sink 不是“即发即丢”，而是带：

- batching
- retry
- 本地失败队列持久化

证据：

- [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
  - `1p_failed_events.`
  - `queueFailedEvents`
  - `retryFailedEvents`
  - `sendEventsInBatches`

### 结论

1P event logging 是当前版本里最完整、最重的一条产品遥测链。

---

## 3. GrowthBook / Feature Flags / Experiment Logging

### 当前状态

存在，而且不只是“开关存在”，实验事件也会进 1P。

### 机制证据

#### A. feature flag / runtime gate 还在

- [resplit/2987.js](/Users/luyiren/unbuned/output/claude/resplit/2987.js:2)
  - `source=${e?"env":"growthbook"}`

- [resplit/5476.js](/Users/luyiren/unbuned/output/claude/resplit/5476.js:2)
  - `onGrowthBookRefresh(...)`

- [resplit/4480.js](/Users/luyiren/unbuned/output/claude/resplit/4480.js:2)
  - `DISABLE_GROWTHBOOK`

这说明当前版本里 GrowthBook 仍然参与运行时决策。

#### B. experiment 事件还会写入 1P

- [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2)
  - `logGrowthBookExperimentTo1P`

### 当前可确认的实验事件字段

从 [resplit/1667.js](/Users/luyiren/unbuned/output/claude/resplit/1667.js:2) 的 `ami(e)` 可直接恢复：

- `event_type: "GrowthbookExperimentEvent"`
- `event_id`
- `experiment_id`
- `variation_id`
- `device_id`
- `account_uuid`
- `organization_uuid`
- `session_id`
- `user_attributes`
  - 当前代码里直接打进去的是：
    - `appVersion`
- `experiment_metadata`
- `environment`
  - 当前代码里写死的是：
    - `production`

### 关于“完整用户画像”这句话

当前代码里我能**明确证明** GrowthBook experiment 事件至少会带：

- 设备 ID
- 账号/组织 ID
- session ID
- appVersion
- experiment metadata

但如果说“完整用户画像”，这个表述还是偏强了一点。  
更稳妥的说法应该是：

> 当前版本里，GrowthBook 实验事件会带一组明显可用于实验分群、会话关联和账号关联的上下文字段。

### 关于端点

当前提取出来的可读 JS 中，我没有直接恢复出一个清晰的 “GrowthBook 自己的 HTTP URL 常量”。

但我能确认：

- GrowthBook 运行时机制还在
- GrowthBook refresh hook 还在
- GrowthBook experiment 事件会进入 1P event logging

所以对于“这条路径还在不在”这个问题，答案是：

**在。**

只是“当前可读 JS 是否单独显式写着一个 GrowthBook HTTP URL”这一点，静态证据还不够直接。

---

## 汇总对照表

| 通道 | 当前状态 | 端点 | 可确认采集内容 |
|---|---|---|---|
| Datadog | 存在 | `https://http-intake.logs.us5.datadoghq.com/api/v2/logs` | 事件名、会话字段、环境字段、身份字段、事件附加字段、规范化后的 `model/tool/status/version` |
| 1P Event Logging | 存在 | `/api/event_logging/v2/batch` | `ClaudeCodeInternalEvent`、`GrowthbookExperimentEvent`、批量/重试/失败落盘 |
| GrowthBook | 存在 | 未直接恢复出单独静态 URL | feature flag、refresh hook、实验事件、实验/变体/设备/账号/组织/session/appVersion/experiment metadata |

---

## 最后一句

如果你现在要一个最准确的、不会过度表述的版本，可以写成：

1. **Datadog**：现在还在，且端点没变。  
2. **1P 事件日志**：现在还在，但当前代码里是 `v2 batch`。  
3. **GrowthBook**：现在还在，实验事件还会进入 1P 日志；当前可读 JS 里没有直接恢复出单独的 GrowthBook HTTP URL 常量。  
