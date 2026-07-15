# Claude Code 2.1.204 三条遥测链路详解

> 分析对象：macOS arm64，Claude Code `2.1.204`。  
> 分析日期：2026-07-14 ~ 2026-07-15（Asia/Shanghai）。  
> 证据来源：2.1.204 内嵌 JavaScript 静态恢复、Bun preload 网络 JSONL、mitmproxy HAR、本机 `~/.claude.json` GrowthBook 缓存；并补充了 2026-07-15 官方直连 + proxy trace 样本。  
> 本文包含真实的持久化 `device_id`、session UUID、环境特征和公开的 Datadog client token，应按敏感材料保存。

命名约定：环境变量、feature flag、killswitch、provider 枚举和配置 key 一律保留 Claude Code 2.1.204 中的英文原名；中文只解释作用，不把开关名称翻译成中文别名。

## 结论摘要

| 链路 | 主要用途 | 精确端点 | 本次是否观察到真实网络请求 |
|---|---|---|---|
| 1P Event Logging | Claude Code 内部产品事件、性能、工具使用、API 结果和 GrowthBook 实验曝光 | `POST https://api.anthropic.com/api/event_logging/v2/batch` | 是；HAR 中 11 个 batch、240 个事件全部被服务端接受 |
| Datadog datalog | 经过事件白名单筛选后的扁平化运行日志 | `POST https://http-intake.logs.us5.datadoghq.com/api/v2/logs` | 是；hook 测试中 10 个 batch、96 条事件，捕获到 7 个 HTTP 202 |
| GrowthBook | 拉取 feature flag/实验分配；通过 SSE 接收配置更新 | `POST https://api.anthropic.com/api/eval/sdk-zAZezfDKGoZuXXKe`；`GET https://api.anthropic.com/sub/sdk-zAZezfDKGoZuXXKe` | DeepSeek 样本没有；2026-07-15 官方直连 proxy 样本观察到 `/api/eval` 请求，响应 403，因此没有继续进入 `/sub` |

一个容易混淆的关系是：GrowthBook 的配置拉取属于第三条链，但实验曝光事件不会发往单独的 GrowthBook logging URL，而是转换成 `GrowthbookExperimentEvent` 后进入第一条 1P batch。

### 官方直连相对 DeepSeek 样本新增观察

- 官方直连时，GrowthBook 不再停留在纯本地缓存分支，而是会真实发起 `POST /api/eval/sdk-zAZezfDKGoZuXXKe`；旧 DeepSeek 样本没有这一步。
- 官方直连的 1P 事件里，`auth.account_uuid`、`auth.organization_uuid`、`head_sha` 本轮真实出现；旧 DeepSeek 代表样本里这些字段没有出现。
- `env.is_claude_ai_auth` 在官方直连样本中为 `true`；旧 DeepSeek 样本为 `false`。
- GrowthBook `/api/eval` 的 `attributes` 在官方直连样本里出现 `organizationUUID`、`accountUUID`、`subscriptionType`、`rateLimitTier`，同时不再出现自定义 upstream 才会有的 `apiBaseUrlHost`；旧 DeepSeek 样本刚好相反。
- 官方直连的 proxy 样本在 `system[0].text` 中真实看到了 `x-anthropic-billing-header: ... cch=00000;` 占位符；旧 DeepSeek proxy 样本在同层没有观察到这一占位符。这个差异只说明“上层 request builder 可见性”不同，不改变最终 `cch` 仍由 native body-prepare 改写的结论。

## 共同前置概念

### `firstParty` 不等于官方直连

2.1.204 的 provider 枚举只把 Gateway、Bedrock、Vertex、Foundry、Anthropic AWS 和 Mantle 分出去；普通自定义 `ANTHROPIC_BASE_URL` 仍会落到 `firstParty`。所以旧 DeepSeek 样本虽然实际请求发往 `https://api.deepseek.com/anthropic/v1/messages`，内部事件依然会记录 `provider = firstParty`。

### 模型请求中的 attribution builder

`x-anthropic-billing-header` 不是 HTTP header，而是模型请求 JSON body 里 `system[0].text` 的一行 attribution 文本。JavaScript 层负责拼 `cc_version`、`cc_entrypoint`，并在部分路径下先放一个 `cch=00000` 占位符；最终真实的 5 位 `cch` 一定是在 native body-prepare 阶段原地改写，不是 JavaScript 直接算出来的。

上层 builder 什么时候会先放 `cch=00000`，当前可以压成两条：

- `provider === "vertex"`
- `provider === "firstParty"` 且当前 upstream 被视为官方 Anthropic（未设置 `ANTHROPIC_BASE_URL`，或其 `host` 精确等于 `api.anthropic.com`；内部 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` 也可强制满足）

因此：

- 官方直连 proxy 样本在 `system[0].text` 中看到了 `cch=00000`
- 旧 DeepSeek proxy 样本在同层没有看到这个占位符
- 这个差异只影响 JavaScript 层可见性，不影响最终 `cch` 仍由 native 改写

#### `x-anthropic-billing-header` 三个子字段

| 子字段 | 生成方式 | 当前可验证的真实值/样例 |
|---|---|---|
| `cc_version` | `VERSION + "." + fp3`；其中 `fp3 = sha256("59cf53e54c78" + msg[4] + msg[7] + msg[20] + VERSION).hex().slice(0, 3)` | `2.1.204.5a7`、`2.1.204.9b9` |
| `cc_entrypoint` | 直接取 `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` |
| `cch` | native `sub_10142D258` 中对 prepared JSON body 做 `XXH64(seed=0x4d659218e32a3268)`；跳过 `"model":"<value>"` 的 value，取 digest 低 20 bit 编成 5 位小写 hex，再原地覆写 `cch=00000` | `d004c`、`c1f8f`、`92d13` |

这里 `msg` 不是 wrapper 后的第一段 `<system-reminder>`，而是“本轮第一个真实用户文本”。当前可复算的两个样例：

| 场景 | `msg` 取值 | `msg[4]`/`msg[7]`/`msg[20]` | 结果 |
|---|---|---|---|
| title request | `<session>\nUse the Bash tool ...` | `s` / `n` / `s` | `5a7` |
| 主模型请求 | `Use the Bash tool to execute pwd. Then reply ...` | `t` / ` ` / ` ` | `9b9` |

第二个例子尤其能说明 wrapper 不是输入：如果错误地对 `<system-reminder>...` 那段文本取 `msg[4]`/`msg[7]`/`msg[20]`，当前同一请求只会得到 `43c`，而真实值是 `9b9`。

等价实现可写成：

```js
const BILLING_SALT = "59cf53e54c78";

function ccVersionFingerprint(msg, version) {
  return crypto
    .createHash("sha256")
    .update(BILLING_SALT + msg[4] + msg[7] + msg[20] + version)
    .digest("hex")
    .slice(0, 3);
}

function cchValue(preparedBodyBytes) {
  // native sub_10142D258:
  // 1. find "system":[
  // 2. find cch=00000
  // 3. XXH64(body, seed=0x4d659218e32a3268), but skip `"model":"<value>"` value bytes
  // 4. return lower 20 bits as five lowercase hex chars
}
```

受控同进程 probe 的直接证据：

| XXH64 digest | 低 20 bit | body 中真实改写后的 `cch` |
|---|---|---|
| `0x232b8b0fc55d004c` | `0xd004c` | `cch=d004c` |
| `0xe8224a7adaac1f8f` | `0xc1f8f` | `cch=c1f8f` |

#### 其他常见 model request header / probe 生成方式

| Header / 请求 | 生成方式 | 当前真实值/观察结果 |
|---|---|---|
| `Accept` | 固定常量 | `application/json` |
| `Content-Type` | 固定常量 | `application/json` |
| `User-Agent`（模型请求） | `claude-cli/${VERSION} (${userType}, ${CLAUDE_CODE_ENTRYPOINT})` | `claude-cli/2.1.204 (external, sdk-cli)` |
| `x-app` | 固定常量 | `cli` |
| `x-claude-code-session-id` | 当前 Claude 会话 UUID | 例如 `c48ed5af-3a6d-4e29-9278-7078aa29f703` |
| `anthropic-version` | 固定 API version | `2023-06-01` |
| `anthropic-dangerous-direct-browser-access` | 固定常量 | `true` |
| `anthropic-beta` | 按请求类型拼好 beta 列表后 `join(",")`；title 请求和主模型请求的列表不完全相同 | title 请求：`claude-code-20250219,...,mid-conversation-system-2026-04-07,effort-2025-11-24,structured-outputs-2025-12-15`；主模型请求：`interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219` |
| `x-stainless-*` | 来自 bundled Anthropic JS SDK / Stainless runtime 元数据，不是 Claude 产品层自己拼接 | `x-stainless-arch=arm64`、`x-stainless-lang=js`、`x-stainless-os=MacOS`、`x-stainless-package-version=0.94.0`、`x-stainless-retry-count=0`、`x-stainless-runtime=node`、`x-stainless-runtime-version=v26.3.0`、`x-stainless-timeout=600` |
| `Authorization` / `x-api-key` | 取当前 upstream auth resolution；对自定义 DeepSeek-compatible base URL，当前捕获里只看到被 redact 的 `authorization` | GrowthBook 是否发起 `/api/eval` 也依赖“官方 auth header resolution 是否成功” |
| `HEAD <ANTHROPIC_BASE_URL>` probe | 发送 `HEAD` 到 base URL，本轮观测到没有附带自定义 header | 看到 `HEAD https://api.deepseek.com/anthropic`；official baseline 还看到一次 `HEAD https://api.anthropic.com` |

---

## 1. 1P Event Logging

### 1.1 触发与发送路径

内部事件首先通过统一的 `logEvent`/`logEventAsync` 入口产生，然后转换成 OpenTelemetry log record，最终由 1P exporter 组装成 batch：

```text
产品逻辑触发 tengu_* 事件
  -> 收集 core/env/auth/process/event metadata
  -> OpenTelemetry logger 队列
  -> transformLogsToEvents()
  -> { events: [...] }
  -> /api/event_logging/v2/batch
```

主要门控（开关均使用 2.1.204 英文原名）：

| 原始名称/条件 | 允许发送的条件 | 作用 |
|---|---|---|
| `getAPIProvider() === "firstParty"` | 为真 | 自定义 DeepSeek `ANTHROPIC_BASE_URL` 仍满足该 provider 枚举；`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 为真时可绕过这一 provider 限制 |
| runtime `gatewayAuth` / `CLAUDE_CODE_USE_GATEWAY` | 没有进入 Gateway auth 状态 | Gateway 状态会关闭 1P exporter |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 未设置 | 设置后 traffic mode 为 `essential-traffic`，关闭 1P |
| `DISABLE_TELEMETRY` | 未设置 | 设置后 traffic mode 为 `no-telemetry`，关闭 1P |
| `DO_NOT_TRACK` | 未解析为 truthy | truthy 时 traffic mode 为 `no-telemetry`，关闭 1P |
| `tengu_frond_boric.firstParty` | 不为 `true` | 1P killswitch |
| `tengu_event_sampling_config.<event>.sample_rate` | 未命中 `0` 或随机采样保留 | 单事件采样；`0` 直接丢弃，`0 < sample_rate < 1` 随机保留 |

### 1.2 端点、认证和 batch 参数

当前默认端点：

```text
POST https://api.anthropic.com/api/event_logging/v2/batch
```

基础请求头：

| Header | 生成方式 | 当前真实值/说明 |
|---|---|---|
| `Content-Type` | 固定常量 | `application/json` |
| `User-Agent` | `claude-code/${VERSION}` | `claude-code/2.1.204` |
| `x-service-name` | 固定常量 | `claude-code` |
| `Authorization` / `x-api-key` | 官方 auth header resolution；首发请求可带认证，401/特定失败路径可去掉认证重试 | 当前代表性请求中未出现 |

本机 GrowthBook 缓存中的实际 batch 配置：

```json
{
  "scheduledDelayMillis": 5000,
  "maxExportBatchSize": 200,
  "maxQueueSize": 8192
}
```

实现还包含失败事件本地文件队列，文件名前缀为 `1p_failed_events.`，并支持 backoff、批量重试和最大尝试次数。

### 1.3 顶层结构

```json
{
  "events": [
    {
      "event_type": "ClaudeCodeInternalEvent",
      "event_data": {}
    }
  ]
}
```

当前能明确确认的 `event_type`：

| `event_type` | 来源 |
|---|---|
| `ClaudeCodeInternalEvent` | 普通 `tengu_*` 内部事件 |
| `GrowthbookExperimentEvent` | GrowthBook 实验曝光；仍通过 1P endpoint 发送 |

### 1.4 `ClaudeCodeInternalEvent` 字段表

| Key | 含义 | 采集方式 | 本次真实值/示例 |
|---|---|---|---|
| `event_id` | 单事件 UUID | `crypto.randomUUID()` | `794e4f20-06a1-428a-9de6-f501e192a1fa` |
| `event_name` | 产品事件名 | 调用方传入 | `tengu_api_success` |
| `client_timestamp` | 客户端事件时间 | 当前时间转换为 ISO-8601 | `2026-07-14T05:32:35.284Z` |
| `device_id` | 持久设备标识 | Claude Code 本地 device ID 生成/读取链 | `3a232b1a1d788667a15e0720564540eb32345f739c5a36ec20f91587c1f6d93d` |
| `session_id` | Claude 会话 UUID | 会话状态 | `4573af8e-cfbb-448c-a761-e8904186d295` |
| `model` | 当前内部模型名 | 模型选择状态 | `deepseek-v4-pro` |
| `user_type` | 用户类型 | 固定/账户上下文 | `external` |
| `betas` | 启用的 beta 列表 | 请求 beta 配置拼接 | `claude-code-20250219,...,effort-2025-11-24` |
| `entrypoint` | 运行入口 | `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` |
| `is_interactive` | 是否交互式 UI | 运行时状态 | `false` |
| `client_type` | 客户端类型 | 运行时状态 | `sdk-cli` |
| `process` | 进程指标 | `process.memoryUsage()`、`process.cpuUsage()` 等；JSON 后 base64 | 见下方解码示例 |
| `additional_metadata` | 事件特有字段 | 调用方 metadata 过滤后 JSON/base64 | 见下方 `tengu_api_success` 解码示例 |
| `auth.account_uuid` | Anthropic 账户 UUID | OAuth/account profile | DeepSeek 代表样本未出现；官方直连样本出现 `1c591bcf-c5d4-4931-b5bd-7362b8a4cc32` |
| `auth.organization_uuid` | Anthropic 组织 UUID | OAuth/account profile | DeepSeek 代表样本未出现；官方直连样本出现 `40e875d4-3561-4853-9bd1-5dacef51a557` |
| `email` | 邮箱 | 账户上下文 | 当前未上报 |
| `agent_id` | 子 agent ID | agent async context | 当前代表事件未上报 |
| `parent_session_id` | 父会话 ID | agent async context | 当前代表事件未上报 |
| `agent_type` | `standalone`/`teammate` 等 | agent 状态 | 当前代表事件未上报 |
| `team_name` | agent team 名 | team 状态 | 当前代表事件未上报 |
| `skill_name` | skill 名 | `_PROTO_skill_name` 特殊提升 | 仅相关事件出现 |
| `plugin_name` | plugin 名 | `_PROTO_plugin_name` 特殊提升 | 仅相关事件出现 |
| `marketplace_name` | marketplace 名 | `_PROTO_marketplace_name` 特殊提升 | 仅相关事件出现 |
| `repl_code` | REPL 相关 code | `_PROTO_code` 特殊提升 | 仅相关事件出现 |
| `head_sha` | Git HEAD SHA/派生值 | Git 上下文 | DeepSeek 代表样本未出现；官方直连样本出现 `38e9e9ce6268ddd23ad7d5abc2c4b5584a1d7ed1` |
| `swe_bench_run_id` | SWE-bench run | 环境变量 | 当前为空 |
| `swe_bench_instance_id` | SWE-bench instance | 环境变量 | 当前为空 |
| `swe_bench_task_id` | SWE-bench task | 环境变量 | 当前为空 |

### 1.5 `env` 字段表

| Key | 含义/来源 | 当前真实值 |
|---|---|---|
| `platform`, `platform_raw` | 标准化/原始平台 | `darwin`, `darwin` |
| `arch` | CPU 架构 | `arm64` |
| `node_version` | 暴露给应用的 Node/Bun 兼容版本 | `v26.3.0` |
| `terminal` | 终端类型 | `dumb` |
| `shell` | shell 探测 | `zsh` |
| `package_managers` | PATH/环境中可用的包管理器 | `npm,yarn,pnpm` |
| `runtimes` | 可用运行时 | `node` |
| `is_running_with_bun` | Bun runtime 检测 | `true` |
| `is_ci` | CI 环境检测 | `false` |
| `is_claubbit` | 内部运行环境检测 | `false` |
| `is_github_action` | `GITHUB_ACTIONS` 等环境检测 | `false` |
| `is_claude_code_action` | Claude Code Action 环境检测 | `false` |
| `is_claude_ai_auth` | Claude.ai OAuth auth 判定 | DeepSeek 样本为 `false`；官方直连样本为 `true` |
| `is_claude_code_remote` | Remote 环境 | `false` |
| `is_local_agent_mode` | local-agent entrypoint | `false` |
| `is_conductor` | Conductor 环境 | `false` |
| `version`, `version_base` | Claude Code 版本 | `2.1.204` |
| `build_time` | 构建时间 | `2026-07-07T23:19:03Z` |
| `deployment_environment` | 部署环境 | `unknown-darwin` |
| `vcs` | VCS 类型；按上下文可选 | `git`（在 datalog 样本中出现） |
| `github_event_name` 等 | GitHub Actions metadata | 当前未上报 |
| `wsl_version` | WSL 检测 | 当前未上报 |
| `linux_distro_id/version/kernel` | Linux 系统信息 | macOS 下未上报 |
| `remote_environment_type/container_id/remote_session_id` | Claude Remote 信息 | 当前未上报 |
| `tags` | `CLAUDE_CODE_TAGS` | 当前未上报 |

### 1.6 真实 `process` 解码值

```json
{
  "uptime": 5.099096959000001,
  "rss": 368492544,
  "heapTotal": 65640448,
  "heapUsed": 46579832,
  "external": 20710824,
  "arrayBuffers": 1684363,
  "constrainedMemory": 17179869184,
  "cpuUsage": {
    "user": 496509,
    "system": 100479
  }
}
```

### 1.7 真实 `tengu_api_success.additional_metadata` 解码值

```json
{
  "model": "deepseek-v4-pro",
  "messageCount": 2,
  "messageTokens": 0,
  "inputTokens": 38850,
  "outputTokens": 30,
  "cachedInputTokens": 0,
  "uncachedInputTokens": 0,
  "durationMs": 4519,
  "durationMsIncludingRetries": 4522,
  "attempt": 1,
  "ttftMs": 459,
  "buildAgeMins": 9013,
  "provider": "firstParty",
  "stop_reason": "end_turn",
  "costUSD": 0.195,
  "didFallBackToNonStreaming": false,
  "isNonInteractiveSession": true,
  "print": true,
  "isTTY": false,
  "querySource": "sdk",
  "queryChainId": "290fba25-7a97-47b7-9b81-bd7d95a9b951",
  "queryDepth": 0,
  "permissionMode": "default",
  "globalCacheStrategy": "none",
  "textContentLength": 14,
  "thinkingContentLength": 92,
  "imageBlockCount": 0,
  "imageTotalPixels": 0,
  "imageTotalBytes": 0,
  "documentBlockCount": 0,
  "documentTotalBytes": 0,
  "inputTextCharLength": 7735,
  "estimatedInputTokens": 2578,
  "fastMode": false,
  "baseUrl": "efdbb18afca7",
  "envModel": "deepseek-v4-pro",
  "timeSinceLastApiCallMs": 2745
}
```

这里的 `baseUrl` 来自 `ANTHROPIC_BASE_URL`，不是最终 `/v1/messages?...` 请求 URL。1P 链路会先做规范化（去掉 credentials、query、fragment 和末尾 `/`），然后：

- 若 host 属于 `anthropic.com` / `claude.ai` / `claude.com`，保留规范化后的 URL 明文
- 否则对规范化结果做 `SHA-256`，取小写 hex 前 12 位

当前 DeepSeek 样本中：

```text
ANTHROPIC_BASE_URL = https://api.deepseek.com/anthropic
normalized         = https://api.deepseek.com/anthropic
1P baseUrl         = efdbb18afca7
```

可直接复算：

```sh
printf '%s' 'https://api.deepseek.com/anthropic' | shasum -a 256 | cut -c1-12
# efdbb18afca7
```

路径会参与这 12 位哈希，因此 `https://api.deepseek.com` 与 `https://api.deepseek.com/anthropic` 会得到不同值。这里没有直接上传 prompt 文本，但上传了输入字符数、估算 token、thinking/text 长度、模型、成本、耗时、TTFT、query chain 和 base URL 信息。其他事件类型可能携带不同 metadata。

### 1.8 真实发送结果

`claude-code-2.1.204-telemetry-enabled/claude.har` 中观察到：

- 11 个 1P batch。
- 请求体大小约 3.2 KiB 到 142 KiB。
- 11 个请求全部 HTTP 200。
- 服务端响应累计 `accepted_count = 240`，`rejected_count = 0`。

真实响应示例：

```json
{
  "accepted_count": 76,
  "rejected_count": 0
}
```

---

## 2. Datadog datalog

### 2.1 触发条件 

一个事件进入 Datadog 必须同时满足：

1. `tengu_log_datadog_events === true`；本机真实缓存值为 `true`。
2. `tengu_frond_boric.datadog !== true`，即没有触发 killswitch。
3. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`DISABLE_TELEMETRY` 均未设置，且 `DO_NOT_TRACK` 未解析为 truthy。
4. `CLAUDE_CODE_ENVIRONMENT_KIND !== "byoc"`；如果等于 `byoc`，还必须显式启用 `CLAUDE_CODE_BYOC_ENABLE_DATADOG`。
5. `getAPIProvider() === "firstParty"`。
6. 事件名位于硬编码 Datadog allowlist。
7. 如果有 `model`，其小写形式必须包含 `claude`。

本机原始模型为 `deepseek-v4-pro`，因此之前在第 7 步返回。测试 hook 只把 Claude Code 解析到的模型改为 `claude-haiku-4-5`，没有修改 provider 函数或上述开关。

### 2.2 端点与发送行为

```text
POST https://http-intake.logs.us5.datadoghq.com/api/v2/logs
```

真实请求头：

| Header | 生成方式 | 当前真实值/说明 |
|---|---|---|
| `Content-Type` | 固定常量 | `application/json`；body 是日志对象数组 |
| `DD-API-KEY` | Claude Code 2.1.204 二进制内置的公开 Datadog client token | `pubea5604404508cdd34afb69e6f42a05bc`；不是用户的 DeepSeek/Anthropic token |
| `User-Agent` | Axios 默认 `User-Agent` | `axios/1.15.2` |
| `Accept-Encoding` | Axios/Bun HTTP 栈默认压缩能力声明 | `gzip, compress, deflate, br` |

默认行为：

- 最多积累 100 条后立即 flush。
- 默认 flush 间隔 15 秒，可由 `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` 改写；本次 hook 测试设为 1 秒。
- HTTP timeout 为 5 秒。
- 发送前先从内存数组移除；失败时只写 debug/error 日志，没有看到类似 1P 的磁盘失败队列。

### 2.3 数据转换与归一化

- `toolName` 以 `mcp__` 开头时统一变成 `mcp`。
- `status` 转换成 `http_status` 和 `http_status_range`，随后删除原 `status`。
- 模型名归一化到 Claude 模型族；无法识别时为 `other`。
- dev 版本号去除时间/SHA 后缀。
- JavaScript camelCase metadata 转成 snake_case。
- 常用维度再拼成 `ddtags`，便于 Datadog facet/tag 查询。

### 2.4 字段表

| Key | 含义/采集方式 | 本次真实值/示例 |
|---|---|---|
| `ddsource` | 固定 source | `nodejs` |
| `service` | 固定服务名 | `claude-code` |
| `hostname` | 固定逻辑主机名，不是本机 hostname | `claude-code` |
| `env` | 固定部署标签 | `external` |
| `message` | 事件名 | `tengu_bash_tool_command_executed` |
| `ddtags` | 事件与常用维度拼接 | `event:tengu_bash_tool_command_executed,arch:arm64,...` |
| `model` | 当前模型；经过 Claude 模型归一化 | `claude-haiku-4-5` |
| `session_id` | 会话 UUID | `c48ed5af-3a6d-4e29-9278-7078aa29f703` |
| `user_type` | 用户类型 | `external` |
| `betas` | beta 列表 | `interleaved-thinking-2025-05-14,...` |
| `entrypoint` | 运行入口 | `sdk-cli` |
| `is_interactive` | 是否交互 UI；该字段在实际记录中为字符串 | `"false"` |
| `client_type` | 客户端类型 | `sdk-cli` |
| `process_metrics` | 内存、CPU、uptime | 见下方真实记录 |
| `user_bucket` | 稳定分桶/采样维度 | `11` |
| `rh` | repo/context 派生的短哈希；精确语义未完全命名恢复 | `0bd1a390eda6796d` |
| `platform`, `platform_raw` | 平台 | `darwin`, `darwin` |
| `arch` | 架构 | `arm64` |
| `node_version` | runtime 兼容版本 | `v26.3.0` |
| `terminal`, `shell` | 终端和 shell | `dumb`, `zsh` |
| `package_managers` | 可用包管理器 | `npm,yarn,pnpm` |
| `runtimes` | 可用运行时 | `node` |
| `is_running_with_bun` | Bun 检测 | `true` |
| `version`, `version_base` | Claude Code 版本 | `2.1.204` |
| `build_time` | 构建时间 | `2026-07-07T23:19:03Z` |
| `deployment_environment` | 部署环境 | `unknown-darwin` |
| `vcs` | VCS | `git` |
| `account_uuid`, `organization_uuid` | 账户/组织身份；存在时加入 | 当前记录未出现 |
| `swe_bench_*` | SWE-bench 环境变量 | 当前为空字符串 |
| 事件专用字段 | 调用方 metadata 扁平化 | 例如 bash 的 `exit_code`、`stdout_length`、sandbox/permission 字段 |

### 2.5 真实 `tengu_bash_tool_command_executed` 记录

```json
{
  "ddsource": "nodejs",
  "ddtags": "event:tengu_bash_tool_command_executed,arch:arm64,client_type:sdk-cli,entrypoint:sdk-cli,model:claude-haiku-4-5,platform:darwin,user_bucket:11,user_type:external,version:2.1.204,version_base:2.1.204",
  "message": "tengu_bash_tool_command_executed",
  "service": "claude-code",
  "hostname": "claude-code",
  "env": "external",
  "model": "claude-haiku-4-5",
  "session_id": "c48ed5af-3a6d-4e29-9278-7078aa29f703",
  "user_type": "external",
  "entrypoint": "sdk-cli",
  "is_interactive": "false",
  "client_type": "sdk-cli",
  "process_metrics": {
    "uptime": 7.229933957999999,
    "rss": 330727424,
    "heapTotal": 50850816,
    "heapUsed": 83940077,
    "external": 40676547,
    "arrayBuffers": 2238452,
    "constrainedMemory": 17179869184,
    "cpuUsage": {"user": 1028405, "system": 156739},
    "cpuPercent": 36.987500000000004,
    "cpuWindowMs": 16
  },
  "rh": "0bd1a390eda6796d",
  "platform": "darwin",
  "platform_raw": "darwin",
  "arch": "arm64",
  "node_version": "v26.3.0",
  "terminal": "dumb",
  "shell": "zsh",
  "package_managers": "npm,yarn,pnpm",
  "runtimes": "node",
  "is_running_with_bun": true,
  "is_ci": false,
  "is_claude_code_remote": false,
  "version": "2.1.204",
  "build_time": "2026-07-07T23:19:03Z",
  "deployment_environment": "unknown-darwin",
  "vcs": "git",
  "command_type": "other",
  "stdout_length": 40,
  "stderr_length": 0,
  "exit_code": 0,
  "interrupted": false,
  "executor_shell": "zsh",
  "executor_shell_overridden": false,
  "sandboxed": false,
  "sandbox_enabled": false,
  "dangerously_disable_sandbox": false,
  "filesystem_policy": "strict",
  "destructive_category": "none",
  "destructive_target_scope": "none",
  "git_destructive_target": "none",
  "permission_mode": "default",
  "user_bucket": 11
}
```

该记录没有上传实际命令文本或 stdout 内容，只上传命令类型、输出长度、退出码、shell、sandbox、破坏性分类和权限模式。其他 allowlist 事件具有各自的事件字段。

### 2.6 本次真实事件与发送结果

三轮 hook 交互共 96 条 Datadog 事件：

| 事件名 | 数量 |
|---|---:|
| `tengu_feature_ok` | 71 |
| `tengu_timer` | 6 |
| `tengu_sdk_ttft` | 3 |
| `tengu_sdk_result` | 3 |
| `tengu_init` | 3 |
| `tengu_headless_mcp_prewait` | 3 |
| `tengu_feature_bad` | 3 |
| `tengu_tool_use_success` | 2 |
| `tengu_session_file_read` | 1 |
| `tengu_bash_tool_command_executed` | 1 |

发送结果：

- 10 个 HTTP batch。
- 请求体总计 151,511 bytes。
- 7 个响应被 hook 捕获为 HTTP 202，响应 body 为 `{}`。
- 3 个最终 flush 在短生命周期 CLI 退出前没有记录到响应；这不等价于服务端拒收。
- 没有捕获到 network hook 的 `error` 事件。

---

## 3. GrowthBook

GrowthBook 链应拆成两个方向：

1. Claude Code 向 GrowthBook remote-eval 获取 feature/experiment 分配。
2. 真正发生实验曝光后，Claude Code 把曝光转换成 `GrowthbookExperimentEvent`，并入 1P Event Logging。

### 3.1 开关、初始化门控与 Remote-eval 端点

GrowthBook 的总启用判断是 `isGrowthBookEnabled()`，2.1.204 中等价于：

```js
isGrowthBookEnabled =
  !DISABLE_GROWTHBOOK &&
  is1PEventLoggingEnabled();
```

因此它受以下英文原名开关/状态控制：

| 原始名称/条件 | 允许初始化的条件 | 作用 |
|---|---|---|
| `DISABLE_GROWTHBOOK` | 未设置 | GrowthBook 专用 disable switch |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 未设置 | 通过 `is1PEventLoggingEnabled()` 间接关闭 GrowthBook |
| `DISABLE_TELEMETRY` | 未设置 | 通过 `is1PEventLoggingEnabled()` 间接关闭 GrowthBook |
| `DO_NOT_TRACK` | 未解析为 truthy | 通过 `is1PEventLoggingEnabled()` 间接关闭 GrowthBook |
| `getAPIProvider() === "firstParty"` | 为真，或 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 为 truthy | 复用 1P provider gate |
| runtime `gatewayAuth` / `CLAUDE_CODE_USE_GATEWAY` | 没有进入 Gateway auth 状态 | 复用 1P Gateway gate |
| 官方 `Authorization` / `x-api-key` header resolution | 成功 | 实际调用 SDK `init()`、发送 `/api/eval` 并按响应能力建立 `/sub` |

Claude Code 创建 GrowthBook SDK 时使用：

```js
new GrowthBook({
  apiHost: "https://api.anthropic.com/",
  clientKey: "sdk-zAZezfDKGoZuXXKe",
  remoteEval: true,
  cacheKeyAttributes: ["id", "organizationUUID"],
  attributes: getUserAttributes()
});
```

因此配置请求为：

```text
POST https://api.anthropic.com/api/eval/sdk-zAZezfDKGoZuXXKe
```

SDK 通用的非 remote-eval 路径为 `/api/features/<clientKey>`，但 Claude Code 当前设置 `remoteEval: true`，所以正常不会使用该路径。

当 response header 包含 `x-sse-support: enabled` 时，会建立后台 EventSource：

```text
GET https://api.anthropic.com/sub/sdk-zAZezfDKGoZuXXKe
```

SSE 事件：

| Event | 行为 |
|---|---|
| `features` | 直接解析事件 data，更新当前 feature payload 和缓存 |
| `features-updated` | 重新调用 `/api/eval/<clientKey>` |

SDK refresh 周期与缓存相关参数：

| 参数 | 值 |
|---|---:|
| SDK `maxAge` | 14,400,000 ms（4 小时） |
| SDK `staleTTL` | 60,000 ms |
| SDK `maxEntries` | 10 |
| Claude Code periodic refresh | 21,600,000 ms（6 小时） |

### 3.2 `/api/eval` 请求字段

```json
{
  "attributes": {},
  "forcedVariations": {},
  "forcedFeatures": [],
  "url": ""
}
```

| Key | 含义 | 采集方式 |
|---|---|---|
| `attributes.id` | GrowthBook 分桶主 ID | Claude Code `device_id` |
| `attributes.deviceID` | 同一 device ID 的兼容字段 | Claude Code `device_id` |
| `attributes.sessionId` | 当前会话 UUID | session state |
| `attributes.platform` | 平台 | `darwin` 等 |
| `attributes.apiBaseUrlHost` | 仅自定义 API host 时加入 | `new URL(ANTHROPIC_BASE_URL).host`；DeepSeek 样本为 `api.deepseek.com`，官方直连样本不出现该字段 |
| `attributes.organizationUUID` | 组织 UUID | OAuth/account 或环境变量 |
| `attributes.accountUUID` | 账户 UUID | OAuth/account 或环境变量 |
| `attributes.userType` | 用户类型 | 当前固定/解析为 `external` |
| `attributes.subscriptionType` | 订阅类型 | OAuth/account cache |
| `attributes.rateLimitTier` | 限流 tier | OAuth/account cache |
| `attributes.firstTokenTime` | 首次使用时间 | `claudeCodeFirstTokenDate` |
| `attributes.email` | 账户邮箱 | profile context |
| `attributes.appVersion` | Claude Code 版本 | build constant |
| `attributes.githubActionsMetadata` | GitHub Actions 身份/仓库字段 | `GITHUB_*` 环境变量 |
| `attributes.releaseChannel` | 更新通道 | `autoUpdatesChannel` |
| `attributes.entrypoint` | 入口 | `CLAUDE_CODE_ENTRYPOINT` |
| `attributes.hasUsedRemoteSession` | 是否用过 remote session | 本地状态 |
| `forcedVariations` | 本地强制实验 variation | GrowthBook runtime overrides |
| `forcedFeatures` | 本地强制 feature map 转数组 | GrowthBook runtime overrides |
| `url` | SDK 上下文 URL | CLI 场景通常为空字符串 |

注意这里和 1P 不一样：GrowthBook 只在自定义 upstream 时上传 `attributes.apiBaseUrlHost`，而且是 `new URL(ANTHROPIC_BASE_URL).host` 的明文值，不做规范化哈希。

### 3.3 当前状态下计算出的真实属性值

先看旧 DeepSeek 样本。以下值来自与 datalog 样本相同的 PID 98380 会话状态。它们是代码会用于 remote-eval body 的真实当前值，但当时没有成功形成线上 `/api/eval` 请求：

```json
{
  "attributes": {
    "id": "3a232b1a1d788667a15e0720564540eb32345f739c5a36ec20f91587c1f6d93d",
    "sessionId": "c48ed5af-3a6d-4e29-9278-7078aa29f703",
    "deviceID": "3a232b1a1d788667a15e0720564540eb32345f739c5a36ec20f91587c1f6d93d",
    "platform": "darwin",
    "apiBaseUrlHost": "api.deepseek.com",
    "userType": "external",
    "appVersion": "2.1.204",
    "entrypoint": "sdk-cli"
  },
  "forcedVariations": {},
  "forcedFeatures": [],
  "url": ""
}
```

当前没有 `organizationUUID`、`accountUUID`、`subscriptionType`、`rateLimitTier`、`firstTokenTime`、`email`、`releaseChannel` 或 `hasUsedRemoteSession`，因此这些 key 会省略，而不是发送 `null`。

补充：2026-07-15 官方直连 proxy 样本里，真实发出的 `/api/eval` body 变成：

```json
{
  "attributes": {
    "id": "3a232b1a1d788667a15e0720564540eb32345f739c5a36ec20f91587c1f6d93d",
    "sessionId": "5207a445-54cb-4357-9862-129836c6b7f9",
    "deviceID": "3a232b1a1d788667a15e0720564540eb32345f739c5a36ec20f91587c1f6d93d",
    "platform": "darwin",
    "organizationUUID": "40e875d4-3561-4853-9bd1-5dacef51a557",
    "accountUUID": "1c591bcf-c5d4-4931-b5bd-7362b8a4cc32",
    "userType": "external",
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_ai",
    "appVersion": "2.1.204",
    "entrypoint": "sdk-cli"
  },
  "forcedVariations": {},
  "forcedFeatures": [],
  "url": ""
}
```

也就是说，官方直连相对旧 DeepSeek 样本新增了：

- `organizationUUID`
- `accountUUID`
- `subscriptionType`
- `rateLimitTier`

同时不再携带 `apiBaseUrlHost`。

### 3.4 为什么 DeepSeek 样本没有 `/api/eval` 和 `/sub`

Claude Code 只有在官方 auth header 解析成功后才执行 GrowthBook SDK `init()` 网络请求。当前 DeepSeek token/base URL 场景下，GrowthBook 初始化没有得到可用的官方 `Authorization`/`x-api-key` headers，于是：

- 不调用 `/api/eval/<clientKey>`。
- 不建立 `/sub/<clientKey>` SSE。
- 继续使用 `~/.claude.json` 中的 `cachedGrowthBookFeatures`。

这与抓包一致：两份 HAR 和当前 JSONL 都没有 `eval`、`sub` 或 `features` 请求。

而在 2026-07-15 官方直连 proxy 样本里，`/api/eval` 已经真实发起，只是服务端返回 403，所以仍然没有继续进入 `/sub`。这说明：

- “DeepSeek 样本没有 `/api/eval`” 的原因是没有可用官方 auth header；
- “官方直连样本没有 `/sub`” 的原因则是 `/api/eval` 已发起但被服务端拒绝。

### 3.5 本机当前实际应用的 feature 值

这些值来自 `~/.claude.json.cachedGrowthBookFeatures`，是当前真实生效值：

| Feature key | 当前值 | 可确认用途 |
|---|---|---|
| `tengu_1p_event_batch_config` | `{"scheduledDelayMillis":5000,"maxExportBatchSize":200,"maxQueueSize":8192}` | 1P batch 延迟、批大小、队列大小 |
| `tengu_brass_pebble` | `false` | 内部 feature；当前静态命名不足以可靠恢复业务名 |
| `tengu_disable_bypass_permissions_mode` | `false` | `bypass permissions mode` disable flag |
| `tengu_event_sampling_config` | `{}` | 按事件名配置 1P/Datadog 采样率 |
| `tengu_keybinding_customization_release` | `true` | keybinding customization release gate |
| `tengu_log_datadog_events` | `true` | Datadog datalog enable flag |
| `tengu_log_segment_events` | `false` | Segment event logging flag；当前三链分析未把 Segment 计入独立链 |
| `tengu_marble_anvil` | `true` | 内部 feature；业务语义未可靠恢复 |
| `tengu_mcp_tool_search` | `false` | MCP tool search gate |
| `tengu_scarf_coffee` | `false` | 内部 feature；业务语义未可靠恢复 |
| `tengu_scratch` | `false` | 内部 feature；业务语义未可靠恢复 |
| `tengu_thinkback` | `false` | thinkback gate |
| `tengu_tool_pear` | `false` | 内部 tool feature gate |

当前：

```text
cached feature count = 13
cachedExperimentFeatures = null
```

### 3.6 GrowthBook 实验曝光如何上报

当 remote payload 将某个 feature 标记为 experiment，且实际发生 variation 分配时，Claude Code 调用 `logGrowthBookExperimentTo1P`，生成：

```json
{
  "event_type": "GrowthbookExperimentEvent",
  "event_data": {
    "event_id": "<UUID>",
    "timestamp": "<ISO time>",
    "experiment_id": "<experiment key>",
    "variation_id": "<variation id>",
    "environment": "production",
    "device_id": "<persistent device id>",
    "session_id": "<session UUID>",
    "user_attributes": "{\"appVersion\":\"2.1.204\"}",
    "experiment_metadata": "{\"feature_id\":\"<feature key>\"}",
    "auth": {
      "account_uuid": "<optional>",
      "organization_uuid": "<optional>"
    }
  }
}
```

这里的 `user_attributes` 和 `experiment_metadata` 是 JSON 字符串，不是嵌套对象。

当前所有 JSONL/HAR 中没有观察到 `GrowthbookExperimentEvent`，本机的 `cachedExperimentFeatures` 也为 `null`，所以没有可以诚实填写的“本轮真实曝光值”。不能把上面的结构模板误写成已经上报成功的网络事实。

---

## 4. 三条链的字段重叠与差异

| 数据 | 1P Event | Datadog | GrowthBook eval | GrowthBook exposure |
|---|---:|---:|---:|---:|
| 持久 `device_id` | 是 | 当前记录没有 | 是，作为 `id` 和 `deviceID` | 是 |
| session UUID | 是 | 是 | 是 | 是 |
| account/org UUID | 可选 | 可选 | 可选 | 可选 |
| model | 是 | 是，且会归一化 | eval body 默认不含 model | 默认不含 model |
| 自定义 API host | 以 12 位 `baseUrl` 哈希出现在部分事件 | 取决于事件 metadata | 明文 host：`api.deepseek.com` | 默认不含 |
| OS/arch/runtime | 详细 env 对象 | 详细扁平字段 | 主要是 `platform` | 默认不含 |
| process CPU/RSS/heap | `process` base64 JSON | `process_metrics` 对象 | 否 | 否 |
| 工具结果/权限分类 | 按事件 metadata | allowlist 事件中扁平化 | 否 | 否 |
| feature key/value | 部分 feature/实验事件 | `tengu_feature_*` 可带 `feature_name` | response 返回全部分配值 | `experiment_metadata.feature_id` |
| prompt 原文 | 本次样本未见 | 本次样本未见 | 否 | 否 |
| 输入长度/token/成本 | API 事件中有 | 相应 allowlist API 事件可有 | 否 | 否 |

---

## 5. 抓包/观测方案对比

这一节单独比较三种常用方案：

- 本地 HTTP 代理：启动本地转发器，然后把 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 注入 Claude Code。
- MITM：通过 `HTTPS_PROXY` / `HTTP_PROXY` + 受信任 CA 做 HTTPS 中间人解密。
- JS preload / Proxy：在 Claude Code 同进程里通过 `BUN_OPTIONS=--preload=...` 包装 `fetch` / `http` / `http2`。

### 5.1 三种方案分别截获在哪一层

| 方案 | 截获位置 | 能看到什么 | 看不到什么 |
|---|---|---|---|
| 本地 HTTP 代理（`ANTHROPIC_BASE_URL`） | Claude Code 应用层和真正 upstream 之间 | Claude Code 发给代理的 `/v1/messages` 请求、SSE 响应、代理转发前后的 body/header | 默认看不到 1P / Datadog / GrowthBook，除非这些链路也被单独路由到代理；也看不到客户端原始 TLS |
| MITM | 进程出站 HTTPS 与远端之间 | 最终离开进程的真实 HTTP 请求与响应；模型请求、1P、Datadog、GrowthBook 都可一起看到 | 看不到“解密前”的 TLS 指纹真相；上游看到的是 MITM 的 TLS，而不是 Claude 自己的 TLS |
| JS preload / Proxy | Claude Code 运行时内部，HTTP API 调用点附近 | `system` / `messages` / `tools`、请求参数、SSE 响应片段、函数调用上下文、调用栈附近逻辑 | 看不到 TLS/JA3/JA4；也不保证能看到 native 在最终发包前做的每一步改写 |

### 5.2 优势和劣势

| 方案 | 优势 | 劣势 | 最适合的用途 |
|---|---|---|---|
| 本地 HTTP 代理（`ANTHROPIC_BASE_URL`） | 不需要安装 CA；最容易做“边看边改边转发”；对 `/v1/messages` 和 SSE 流特别友好 | 会改动 Claude Code 自身路由条件：`ANTHROPIC_BASE_URL` 变成自定义 host 后，一些行为会切换；按官方文档，非 `api.anthropic.com` host 下 `ENABLE_TOOL_SEARCH` 默认关闭，Remote Control 也会关闭。对三条遥测链来说，它通常不是全量视角 | 做 LLM 请求转发器、回放、在线改写、构建 viewer |
| MITM | 最接近“最终上网报文”；官方直连场景下不需要改 `ANTHROPIC_BASE_URL`，因此产品逻辑路径更接近真实用户态；可以同时覆盖模型请求、1P、Datadog、GrowthBook | 需要安装并信任 CA；会改变 TLS 指纹、ALPN/HTTP2 细节；对抗性检查、证书校验、pinning 类问题会更敏感 | 做“最终 HTTP 报文真相源”、遥测全量审计、确认 native 改写后的实际 header/body |
| JS preload / Proxy | 行为漂移最小，不改系统 CA、不改网络拓扑；可以和函数 hook 结合，既看网络也看对象/模块调用；非常适合抽取 `system/messages/tools` 这种语义化 LLM trace | 不等于最终 wire truth：某些字段在这里还只是上层占位符，native 发送前可能继续改写；如果未来某部分网络下沉到 native 且不走当前 JS API，可能漏抓 | 做 LLM trace、参数/返回值跟踪、定位是谁在采集/谁在上报 |

### 5.3 结合 Claude Code 2.1.204 的实际差异

#### 本地 HTTP 代理不是“完全被动旁路”

如果采用类似 cc-viewer 的方案，实质是：

1. 启动一个本地 HTTP 代理。
2. 把 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 注入 Claude Code。
3. 本地代理收到 Claude Code 的 Anthropic Messages 请求后，再转发到真正 upstream。

这类方案的好处是实现简单、很适合做可视化 viewer；但它不是“零扰动”：

- Claude Code 会把这个本地地址当作自定义 upstream。
- 一部分 feature gate / 运行条件会跟着切到 custom base URL 分支。
- 如果代理实现还会附加内部标记（例如 `x-cc-viewer-trace`）或重写 `accept-encoding`，那它看到和转发的报文也已经不是“纯原始样子”。

所以，这种方案更适合“主动代理 + 观测 + 改写”，不适合当作 TLS/线上的绝对真相源。

#### MITM 更接近最终 HTTP 真相，但不保留客户端 TLS 指纹

MITM 抓到的是最终发出的 HTTP body/header，这一点对确认下面这些问题最有价值：

- `cch` 是否已经被 native body-prepare 改写；
- 1P batch / Datadog / GrowthBook 到底有没有真正上网；
- 某些 header 是上层 builder 拼的，还是底层在发包前补的。

但只要经过 MITM，上游看到的 TLS ClientHello 就是 MITM 的，不是 Claude Code 原生二进制自己的 JA3 / JA4 / ALPN 组合。因此：

- MITM 适合验证 HTTP 层真相；
- 不适合验证 TLS 指纹真相。

#### JS preload 最适合做 LLM trace

如果目标是“看到每一轮和模型交互的具体 message list、system、tools、响应文本”，preload 是三者里最顺手的：

- 可以直接在同进程拿到 `/v1/messages` body；
- 不需要把 JSON 再从 HAR 里反解；
- 可以把请求和响应按 Claude 语义格式化出来；
- 还可以继续往上追到调用该请求的模块、对象和参数。

但它的边界也要说清楚：

- 它更像“应用层视角”，不是“网卡视角”；
- 对 native 发送前的最终二次加工，必须再拿 MITM 或 native hook 去交叉验证。

### 5.4 我们当前这套工程里的建议分工

| 目标 | 推荐方案 |
|---|---|
| 看最终 HTTP 请求/响应到底发了什么 | MITM |
| 看 `system/messages/tools` 和模型响应内容 | JS preload + `bin/show-llm-trace` |
| 想在线改写请求、做转发器、做 viewer | 本地 HTTP 代理（`ANTHROPIC_BASE_URL`） |
| 想同时审计三条遥测链是否真的上报 | MITM 或同进程 network trace；优先 MITM 确认最终报文 |
| 想确认 native 是否在发包前改了 body/header | MITM + preload 双跑，对照上层视图与最终视图 |
| 想分析 JA3 / JA4 / TLS ClientHello | 上面三种都不够；需要官方直连 + 抓原始流量（如 `tcpdump` / `pcap`），避免 MITM 和本地代理改写 TLS |

### 5.5 结论

一句话压缩：

- 本地 HTTP 代理最适合“接管和改写模型请求”。
- MITM 最适合“看最终 HTTP 真相”和“做三条遥测链全量审计”。
- JS preload 最适合“做 LLM trace”和“追调用链/采集源头”。

因此，当前仓库把 JS preload 作为默认入口，把 network JSONL 当“应用层真相源”；如果要确认最终线上报文，再用 MITM 做交叉验证。两者叠加，基本能把 Claude Code 2.1.204 的模型请求、1P event、Datadog 和 GrowthBook 看全。

## 6. 证据文件

### JSONL

- `network-traces/claude-network-1784007150219-50414.jsonl`：未修改模型名时的真实 1P `tengu_api_success`。
- `captures/official-datalog-20260714-152922/claude-network-1784014538080-98380.jsonl`：启用 datalog hook 后的 Bash/tool/Datadog 记录。

### HAR

- `mitm-captures/claude-code-2.1.204-telemetry-enabled/claude.har`：11 次成功的 1P batch、240 个 accepted events。
- `mitm-captures/claude-code-2.1.204/claude.har`：未启用额外遥测测试时的模型请求基线。

### 本地缓存

- `~/.claude.json.cachedGrowthBookFeatures`：当前 13 个 feature 的真实本地生效值。

## 7. 最终判断

1. **1P Event Logging 是最完整的产品事件主链**：事件数量多、字段丰富、支持 batch/retry/失败落盘；GrowthBook 曝光也复用它。
2. **Datadog 是 1P 事件流的受限子集/旁路 sink**：受 feature flag、provider、事件 allowlist 和 Claude 模型名共同限制，字段被扁平化以便日志检索。
3. **GrowthBook 的独立网络职责是配置与分流，不是主要日志上传**：`eval/sub` 用于 feature payload；曝光记录最终仍进入 1P endpoint。
4. 当前 DeepSeek-compatible 配置被内部 provider 枚举称为 `firstParty`，但并非真正的 Anthropic first-party API backend；GrowthBook 正因为缺少可用官方 auth headers 而只使用磁盘缓存。
