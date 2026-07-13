# Claude Code JS 静态分析报告

日期：2026-07-13

分析范围：
- 主提取 bundle：[claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)
- 拆分后的 JS 模块目录：[/Users/luyiren/unbuned/output/claude/resplit](/Users/luyiren/unbuned/output/claude/resplit)
- 动态恢复出的 provider 源码目录：[/tmp/claude-hook-sources](/tmp/claude-hook-sources)

## 一页结论

1. 这一版 Claude Code 仍然保留了大量 **JS 层业务逻辑**，不是“native 里只有一点点 JS 壳子”。
   主 bundle 本体就是一个 19,104,797 字节的 Bun CJS 包裹文件：
   [claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)

2. 从静态 JS 可以明确看到：
   - 网络请求相关逻辑
   - 认证/账号相关逻辑
   - 遥测/事件上报逻辑
   - feature flag / 实验开关
   - proxy / base URL / 证书 / provider 切换逻辑

3. 目前能确认的事实是：
   **请求决策很多仍然在 JS 层，传输执行则由 Bun/native 完成。**
   所以它不是“只有 native 才会发网”，而是“JS 发起，native 真发包”这种结构。

4. 遥测体系在 JS 层非常明显，`tengu_*` 是最显眼的一组事件名，配套还有：
   - `N(...)`：事件发送
   - `Ae(...)`：成功计数
   - `ve(...)`：失败计数
   - `at(...)`：分类错误指标

5. 当前提取出来的 JS 里，我 **没有直接命中** 你之前提到的那类“proxy / 中国时区 / 日期标点水印”逻辑的可读实现。
   但这 **不能证明它不存在**，因为它仍可能藏在：
   - JSC bytecode 路径
   - native 辅助逻辑
   - 经过压缩/改写后需要数据流还原才能看懂的 JS

6. 我们动态恢复出的额外匿名 provider 源码里，目前看到的那几段匿名逻辑更像：
   - Bun / Node runtime glue
   - streams / event loop / Web Streams 包装层
   暂时不像 Claude 自己的遥测业务逻辑。

## 1. 打包形态与运行时结构

主提取文件开头如下：

- [claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)

可见标记：

- `// @bun @bytecode @bun-cjs`
- 紧接一个大包裹函数：
  `(function(exports, require, module, __filename, __dirname) { ... })`

同一个文件还会直接 `require` 多个 native 模块：

- [claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)
  - `/$bunfs/root/image-processor.node`
  - `/$bunfs/root/computer-use-swift.node`
  - `/$bunfs/root/computer-use-input.node`
  - `/$bunfs/root/audio-capture.node`
  - `/$bunfs/root/url-handler.node`

这说明结构上是：

- JS 层：负责大量控制、业务、配置、请求构造、埋点
- Bun/native 层：负责运行时、传输、TLS、扩展模块

## 2. JS 层暴露出的网络、代理、证书、provider 控制

在提取的 JS 中，和传输相关的环境变量与配置是显式存在的：

- [resplit/0587.js](/Users/luyiren/unbuned/output/claude/resplit/0587.js:2)
  - `HTTP_PROXY`
  - `HTTPS_PROXY`
  - `NO_PROXY`
  - `CLAUDE_CODE_CLIENT_CERT`
  - `CLAUDE_CODE_CLIENT_KEY`
  - `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`
  - `CLAUDE_CODE_CERT_STORE`
  - `ANTHROPIC_CUSTOM_HEADERS`
  - `ANTHROPIC_BETAS`
  - 各种 timeout / token limit

另外还有一个专门的 env 白名单，明显用于 transport/provider 相关配置：

- [resplit/0720.js](/Users/luyiren/unbuned/output/claude/resplit/0720.js:2)
  - `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
  - `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`
  - `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER`
  - `NODE_EXTRA_CA_CERTS`
  - `CLAUDE_CODE_CERT_STORE`
  - `ANTHROPIC_CUSTOM_HEADERS`
  - `CLAUDE_CODE_HOST_CREDS_FILE`
  - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  - 本地 / staging OAuth 开关

provider / base URL 切换也明确可见：

- [resplit/4480.js](/Users/luyiren/unbuned/output/claude/resplit/4480.js:2)
  - `ANTHROPIC_BASE_URL`
  - Bedrock / Vertex / Foundry / AWS / Mantle
  - `DISABLE_GROWTHBOOK`
  - `DISABLE_TELEMETRY`
  - `DO_NOT_TRACK`

结论：

**JS 层明确知道 proxy、证书、provider、base URL、host 托管凭证这些概念。**

## 3. 代理逻辑在 JS 中是存在的

下面这些地方可以直接证明 proxy 处理并不只在 native：

- [claude.js](/Users/luyiren/unbuned/output/claude/claude.js:128)
  - 有 lower-level 的 proxy/no_proxy 判断辅助函数

- [resplit/vendor/proxy-from-env/0001.js](/Users/luyiren/unbuned/output/claude/resplit/vendor/proxy-from-env/0001.js:2)
  - 标准 `proxy-from-env` 风格逻辑
  - 会读取 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`

- [resplit/vendor/gaxios/0004.js](/Users/luyiren/unbuned/output/claude/resplit/vendor/gaxios/0004.js:2)
  - 请求路径里会消费 `HTTPS_PROXY`、`HTTP_PROXY`
  - 会构造代理 agent

- [resplit/3290.js](/Users/luyiren/unbuned/output/claude/resplit/3290.js:2)
  - MCP / agent-proxy 兜底逻辑
  - 条件使用 `HTTPS_PROXY` 和 CA bundle

另外还有一个特殊判断点：

- [resplit/1518.js](/Users/luyiren/unbuned/output/claude/resplit/1518.js:2)
  - `Z$l(...)` 会把 `claudeai-proxy`、`local-agent` 和某些 URL/type 归为特殊情况

我这里不夸大解释 `Z$l(...)` 的具体业务语义，但它至少说明：
**JS 层确实在区分某些“第一方 / 特殊代理 / 特殊通道”上下文。**

## 4. 遥测与事件上报结构

JS 里能看到完整的事件封装层：

- [resplit/1518.js](/Users/luyiren/unbuned/output/claude/resplit/1518.js:2)
  - `N(...)`
  - `Ae(...)`
  - `ve(...)`
  - `at(...)`

而且这一层不仅发事件名，还会拼很多上下文：

- 文件扩展名
- 工具名
- 会话 ID
- env context
- auth 相关字段
- CPU / memory / process metrics
- 交互入口、agent 类型、team 信息

代表性事件族：

- `tengu_file_activity`
  - [resplit/1518.js](/Users/luyiren/unbuned/output/claude/resplit/1518.js:2)

- `tengu_context_tip_reception`
  - [resplit/4149.js](/Users/luyiren/unbuned/output/claude/resplit/4149.js:10)

- `tengu_remote_trigger`
  - [resplit/4551.js](/Users/luyiren/unbuned/output/claude/resplit/4551.js:2)

- `tengu_mcp_command_inline`
  - [resplit/4916.js](/Users/luyiren/unbuned/output/claude/resplit/4916.js:4)

- `tengu_pdf_page_extraction`
  - [resplit/4656.js](/Users/luyiren/unbuned/output/claude/resplit/4656.js:2)

- `tengu_session_file_read`
  - [resplit/4656.js](/Users/luyiren/unbuned/output/claude/resplit/4656.js:14)

- `tengu_bridge_read_file_served`
  - [resplit/5487.js](/Users/luyiren/unbuned/output/claude/resplit/5487.js:2)

- `tengu_refusal_retraction_*`
  - [resplit/5607.js](/Users/luyiren/unbuned/output/claude/resplit/5607.js:2)

- `tengu_skill_tool_invocation`
  - [resplit/3360.js](/Users/luyiren/unbuned/output/claude/resplit/3360.js:2)

- `tengu_auto_default_nudge_*`
  - [resplit/5883.js](/Users/luyiren/unbuned/output/claude/resplit/5883.js:2)

结论：

**这不是“只有 crash/error 级别”的轻量埋点，而是覆盖产品行为、工具使用、引导、远程功能、文件活动等多个层面的产品遥测。**

## 5. 从 JS 中可直接恢复出的 API 面

### 5.1 OAuth / profile

- [resplit/1296.js](/Users/luyiren/unbuned/output/claude/resplit/1296.js:2)
  - `${BASE_API_URL}/api/claude_cli_profile`
  - `${BASE_API_URL}/api/oauth/profile`
  - `${BASE_API_URL}/api/oauth/validate`

这里同时出现：

- API key 头
- Bearer token 头
- 成功 / 失败埋点

### 5.2 项目 / 文档 / KB

- [resplit/2997.js](/Users/luyiren/unbuned/output/claude/resplit/2997.js:2)
  - `/v2/ccr-sessions/-/chat-project`
  - `/api/organizations/:orgUUID/projects/...`
  - `/detail`
  - `/docs/...`
  - `/files/.../extracted`
  - `/kb/search?...`

静态可见的认证模式：

- `auth: "session-jwt"`
- `auth: "teleport-org"`

### 5.3 Remote triggers

- [resplit/4551.js](/Users/luyiren/unbuned/output/claude/resplit/4551.js:2)
  - `/v1/code/triggers`
  - `/v1/code/triggers/{id}`
  - `/v1/code/triggers/{id}/run`

### 5.4 Design sync / marketplace / plugins / MCP

对应逻辑同样在 JS 中很重：

- design sync 和设计系统读写
  - [resplit/4565.js](/Users/luyiren/unbuned/output/claude/resplit/4565.js:2)

- plugin command / skill 加载
  - [resplit/3360.js](/Users/luyiren/unbuned/output/claude/resplit/3360.js:2)

- MCP 控制流
  - [resplit/4916.js](/Users/luyiren/unbuned/output/claude/resplit/4916.js:4)

## 6. Feature flag / 实验开关

提取出来的 JS 里到处都是 `Ze("tengu_*", ...)` / `Ipe("tengu_*", ...)` 这种运行时配置读取。

例子：

- [resplit/2987.js](/Users/luyiren/unbuned/output/claude/resplit/2987.js:2)
  - `tengu_walnut_prism`
  - `tengu_cedar_lantern`

- [resplit/2985.js](/Users/luyiren/unbuned/output/claude/resplit/2985.js:2)
  - `tengu_kairos_brief`

- [resplit/5310.js](/Users/luyiren/unbuned/output/claude/resplit/5310.js:2)
  - `tengu_kairos_brief_config`

这和你之前关心的 growthbook / 实验驱动行为是吻合的：  
**即使我们没在所有地方直接看到 “GrowthBook” 变量名，运行时 feature gate 风格本身是很明显的。**

## 7. 匿名逻辑与动态恢复源码

### 7.1 主 bundle 顶层匿名 wrapper

这部分已经通过动态 hook 精确映射回主 bundle：

- 文件：[claude.js](/Users/luyiren/unbuned/output/claude/claude.js:1)
- SourceCode 范围：`36..19104795`
- function 范围：`28..19104794`

也就是整个 Bun CJS 外层包裹。

### 7.2 额外 provider-backed 源码

我们还从另一个 `SourceProvider` 恢复出了一份额外源码：

- [000000011c059ce0_251892.js](/tmp/claude-hook-sources/000000011c059ce0_251892.js)

这份文件里当前已经切出来 4 段匿名函数：

- `75950..78829`
  - 看起来像 stdin / tty / runtime glue

- `80465..83287`
  - 看起来像 `nextTickQueue / drainMicrotasks / reportUncaughtException`

- `107389..107556`
  - 小的 `ReadableStream` 包裹层

- `108262..111032`
  - `underlyingSource / strategy` 风格的 Web Streams 初始化

目前结论：

**这几段更像 Bun/Node 运行时辅助逻辑，不像 Claude 自己的遥测业务代码。**

## 8. 对“之前传闻中的隐藏 proxy/中国区逻辑”的静态判断

当前静态 JS **明确能证明** 的东西：

- 支持 proxy
- 支持 `ANTHROPIC_BASE_URL`
- 支持 provider 切换
- 存在“特殊通道 / 第一方 / 代理式上下文”的分支处理
- 遥测非常广
- feature flags 很多

当前静态 JS **没有直接恢复出来** 的东西：

- 明文的 `Asia/Shanghai` / `Asia/Urumqi` 分支
- 明文的日期格式/标点水印实现
- 明文的“只有 proxy + 非官方 base URL 才触发的隐藏 prompt 改写”

这意味着：

- 目前在 **已提取、可读的 JS 源码里**，我没有直接命中那段逻辑
- 但这 **不能作为不存在的证明**

剩余可能藏身位置包括：

- JSC bytecode-only 路径
- native/Bun helper
- 被压缩改写后需要做数据流恢复的 JS

## 9. 风险判断

高置信度：

- Claude Code 的 JS 层含有大规模产品遥测/事件逻辑
- JS 层明确参与 transport、auth、proxy、base_url、provider 决策
- 这不是“纯 native 网络 + 很薄 JS 壳”

中置信度：

- 目前恢复出的 `0x11c059ce0` 那份匿名 provider 源码更像 Bun runtime，不像 Claude 遥测主逻辑
- proxy / first-party 特殊处理是真实存在的，但其完整意图还需要更深的运行时关联

低置信度 / 未证实：

- 之前流传的“隐藏中国区 watermark/proxy 逻辑”是否还存在于当前版本
- 是否存在只在 native 层发出、JS 看不到的额外请求路径

## 10. 下一步建议

1. 做版本差异分析：
   - `2.1.91`
   - `2.1.196`
   - `2.1.204`

   重点对比：
   - proxy env 处理
   - `ANTHROPIC_BASE_URL`
   - `tengu_*` 事件
   - prompt / date / formatting 相关逻辑

2. 把静态事件名和真实抓包对起来：
   - 哪些 `tengu_*` 只是本地统计
   - 哪些真正出站
   - 非 first-party / proxy / host-managed 凭证时是否分流

3. 继续顺着主 `claude.js` 做匿名函数偏移索引，而不是只盯 Bun runtime provider

## 最终结论

就 JS 层而言，现在已经可以明确说：

- Claude Code 的网络决策并不只在 native
- 认证/遥测/代理/base_url/provider 切换大量留在 JS
- 静态上报面很宽，`tengu_*` 是核心事件族

但就“你之前提到的那段隐藏 proxy/中国区逻辑”而言：

**我目前还没有在当前版本的可读 JS 中直接找到它的明文实现。**

这不是洗白，也不是定罪，只是当前静态证据的边界。  
真要把这件事钉死，下一步最有效的是：**版本 diff + 运行时请求关联**。
