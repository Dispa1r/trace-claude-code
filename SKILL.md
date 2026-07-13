---
name: claude-code-trace
description: 使用 LLDB 为已安装的 Claude Code 构建本地追踪工具链，覆盖 JSC 调用边界、网络连接/载荷、provider 源码恢复和 JSONL 摘要。适合做取证、行为复盘、请求抓取和系统上下文分析。
---

# Claude Code Trace Skill

这个 skill 打包了当前工作区里已经验证过的一套 Claude Code 本地追踪工具。

目标：

- 追踪 Claude Code 的 JSC 执行边界
- 抓取 native 层网络连接与载荷
- 从运行时对象恢复源码区间与 provider 源码
- 汇总 JSONL 追踪结果

## 包内文件

- `README.md`
- `native_lldb.py`
- `prepare-hookable-copy.sh`
- `run-native-trace.sh`
- `run-network-trace.sh`
- `summarize-trace.py`
- `claude-hook.entitlements.plist`
- `native-trace.js`
- `reports/`

## 典型用法

JSC 调用追踪：

```sh
CC_HOOK_LOG=/tmp/claude-jsc.jsonl ./run-native-trace.sh
```

native 网络追踪：

```sh
CC_HOOK_LOG=/tmp/claude-net.jsonl ./run-network-trace.sh
```

附带读入方向：

```sh
CC_HOOK_LOG=/tmp/claude-net.jsonl CC_NET_CAPTURE_READS=1 ./run-network-trace.sh
```

追踪摘要：

```sh
python3 ./summarize-trace.py /tmp/claude-jsc.jsonl
```

## 关键特性

### 1. JSC 边界追踪

默认可挂：

- `JSC::evaluate`
- `JSC::call`
- `Interpreter::executeCall`
- `Interpreter::executeCallImpl`

同时会尽量恢复：

- `FunctionExecutable`
- `UnlinkedFunctionExecutable`
- `SourceCode` 区间
- `SourceProvider`
- provider 持有的源码字符串

### 2. 网络追踪

当前网络追踪是 best-effort 模式，优先尝试：

- `connect`
- `close`
- `send`
- `sendmsg`
- `write`
- `writev`
- `SSL_write`

可选抓入站：

- `recv`
- `recvmsg`
- `read`
- `SSL_read`

注意：

- HTTP 明文通常能直接看到
- HTTPS 明文只有在 `SSL_write` 命中时才能看到
- 如果只命中 socket 层写入，则看到的是加密后数据块

### 3. provider 源码恢复

脚本会把命中的大 `StringImpl` / provider 源码自动落盘到：

- `/tmp/claude-hook-sources`

网络载荷默认落盘到：

- `/tmp/claude-hook-network`

## 运行前提

- 本机已安装 Claude Code
- macOS 上允许 ad-hoc codesign
- 系统自带 LLDB 可用

## 说明

- 这个 skill 不依赖 Frida 作为主后端
- 当前主工作流基于 LLDB Python breakpoint callback
- 包内 `native-trace.js` 只是 Frida 试验稿，不是默认入口

## 参考报告

`reports/` 目录中附带了当前版本的分析文档：

- `claude-js-static-analysis-2026-07-13-zh.md`
- `telemetry-channels-field-table-2026-07-13-zh.md`
- `claude-system-context-assembly-2026-07-13-zh.md`
