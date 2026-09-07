# 微信开发者工具 MCP 使用说明

本项目通过 `wechat-devtools-mcp` 连接微信开发者工具，可用于启动项目、编译、自动化交互、截图和采集运行时日志。

仓库已经包含项目级 MCP 配置和统一启动器。正常情况下，无需在用户目录中维护项目绝对路径，也不要把个人用户名、盘符或微信开发者工具安装目录写进共享配置。

## 工作方式

以下文件共同完成自动配置：

- `.codex/config.toml`：Codex 项目级配置；项目被信任后，Codex 桌面端、CLI 和 IDE 扩展会读取它。
- `.mcp.json`：供支持项目级 `mcp.json` 的客户端使用，例如 Claude Code；应从仓库根目录打开项目。
- `scripts/start-wechat-devtools-mcp.mjs`：统一启动器，负责解析项目路径、发现微信开发者工具 CLI，并启动 MCP 服务。

启动器会自动完成：

1. 根据脚本所在位置计算仓库根目录，并设置 `WECHAT_PROJECT_PATH`。
2. 优先读取已有的 `WECHAT_DEVTOOLS_CLI`；未设置时，在 macOS 标准目录，或 Windows 注册表和常见安装目录中查找 `cli`。
3. 从 `PATH` 查找 `uvx`，再运行已验证的 `wechat-devtools-mcp 0.9.18`。

因此仓库移动位置、切换用户或由协作者克隆后，通常不需要修改 MCP 配置。

## 首次使用

### 1. 准备依赖

- 安装微信开发者工具。
- 在微信开发者工具的“设置 → 安全”中开启服务端口。
- 安装 Node.js；本项目的日常开发本身也依赖 Node.js。
- 安装 [uv](https://docs.astral.sh/uv/)，并确保 `uvx` 可从 `PATH` 访问。

无需预先全局安装 `wechat-devtools-mcp`；`uvx` 会按需准备隔离运行环境。仓库固定使用已验证版本，升级时只需调整统一启动器中的版本并重新验证，不需要同步修改各客户端配置。

### 2. 验证自动发现

在仓库根目录执行：

```shell
npm run check:mcp
```

输出中的 `ok` 应为 `true`，并显示实际发现的项目目录、微信 CLI、`uvx` 路径和版本。该命令只检查本地路径与 `uvx` 可执行性，不会启动 MCP 或微信开发者工具。

### 3. 让客户端加载配置

- Codex：信任本项目后，重新打开项目或重启 Codex；可用 `/mcp` 或 `codex mcp list` 检查 `wechat-devtools-mcp`。
- 支持项目级 `.mcp.json` 的客户端：从仓库根目录重新打开项目或重载 MCP 服务，并接受客户端首次显示的项目 MCP 授权提示。
- 只支持全局配置的客户端：让全局配置调用本仓库的启动器，不要复制 `WECHAT_PROJECT_PATH`。示例见下文。

最后还要做运行态确认：在客户端的 MCP 面板或 `/mcp` 中确认服务已连接并列出工具，再调用只读的 `wechat_ide(action="status")`。`check:mcp` 和 `codex mcp list` 本身都不代表 MCP 已完成握手或已连接微信开发者工具。

## 客户端配置

### Codex

仓库已提供 `.codex/config.toml`，无需修改 `~/.codex/config.toml`：

```toml
[mcp_servers.wechat-devtools-mcp]
command = "node"
args = ["scripts/start-wechat-devtools-mcp.mjs"]
cwd = "."
startup_timeout_sec = 30
```

项目级配置只会在受信任项目中加载。首次由 `uvx` 准备环境可能较慢，因此启动超时设置为 30 秒。

### 支持项目级 `.mcp.json` 的客户端

仓库根目录已提供：

```json
{
  "mcpServers": {
    "wechat-devtools-mcp": {
      "command": "node",
      "args": ["scripts/start-wechat-devtools-mcp.mjs"]
    }
  }
}
```

### 只支持全局配置的客户端

如果客户端不会读取项目级配置，可在其全局 MCP 配置中调用启动器。下面的 JSON 只适用于使用 `mcpServers` 格式的客户端；其他客户端应按自身格式填写。这里唯一需要维护的是仓库位置：

```json
{
  "mcpServers": {
    "wechat-devtools-mcp": {
      "command": "node",
      "args": ["D:\\path\\to\\freshKeeper\\scripts\\start-wechat-devtools-mcp.mjs"]
    }
  }
}
```

这种客户端仍需在仓库移动后更新一次启动器路径，但项目路径和微信 CLI 路径都由启动器维护。

## 调用约定

- 第三方服务名统一为 `wechat-devtools-mcp`。微信开发者工具 2.x 的官方内建 MCP 可能使用 `wechat-devtools`，两个服务同时启用时不要混淆。
- 工具参数以当前客户端展示的 schema 为准。下方示例按当前第三方 MCP 的 schema 使用 `{"params": {...}}`；如果客户端展示的实参结构不同，以客户端为准。
- `project_path` 通常可以省略，服务会使用启动器注入的当前仓库路径。跨项目操作时才显式传入目标路径。
- 默认 CDP 端口为 `9222`，自动化端口为 `9420`。同一条调试链路应保持端口一致；并行调试多个项目时使用不同端口。
- `upload` 会上传小程序版本，只有任务明确要求时才调用。

## 推荐调试流程

不同版本的工具参数可能变化，应优先读取客户端展示的 MCP 工具说明。常规流程保持不变：

1. 调用 `wechat_ide` 的 `open` 动作，启用 CDP，并指定 CDP 端口。
2. 调用 `wechat_automator` 的 `start` 动作，并指定自动化端口。
3. 使用 `wechat_navigate` 跳转页面，或用 `wechat_automator` 执行点击、输入和状态查询。
4. 使用 `wechat_inspector` 采集控制台、JavaScript 异常或 CDP 日志。
5. 使用 `wechat_screenshot` 截图。按运行时 schema 提供 `output_path`；需要该参数时，应使用本项目 `screenshots` 目录下的绝对路径。

示例：打开当前项目并启用 CDP。

```json
{
  "params": {
    "action": "open",
    "cdp_enabled": true,
    "cdp_port": 9222
  }
}
```

示例：启动自动化连接。

```json
{
  "params": {
    "action": "start",
    "auto_port": 9420
  }
}
```

示例：跳转页面并采集简要日志。

```json
{
  "params": {
    "page_path": "pages/home/index",
    "auto_port": 9420,
    "cdp_port": 9222,
    "wait_ms": 2000,
    "detail_level": "concise"
  }
}
```

## 覆盖自动发现结果

只有自动发现失败时才需要设置环境变量：

- `WECHAT_DEVTOOLS_CLI`：微信开发者工具 `cli.bat` 或 macOS `cli` 的绝对路径。
- `WECHAT_MCP_UVX`：`uvx` 可执行文件路径或命令名。
- `WECHAT_CLI_TIMEOUT`：微信 CLI 操作超时秒数，默认由 MCP 服务决定。

这些变量应放在个人环境或客户端私有配置中，并在启动 MCP 客户端前设置；GUI 客户端通常需要完全重启后才会读取新环境。不要提交个人绝对路径。

## 常见问题

### MCP 服务未出现

确认当前客户端支持对应的项目级配置格式，并已信任项目、从仓库根目录重新打开项目或重载 MCP。Codex 可执行 `codex mcp list` 查看配置是否加载，再用 `/mcp` 和 `wechat_ide(status)` 确认运行态。

### `npm run check:mcp` 找不到微信 CLI

先确认微信开发者工具已正确安装。自定义安装方式若没有写入 Windows 的 `wechatide` 注册信息，可在个人环境中设置 `WECHAT_DEVTOOLS_CLI`。

### 找不到 `uvx`

安装 uv 后重新打开终端和 MCP 客户端，确保新 `PATH` 已生效。也可以用个人环境变量 `WECHAT_MCP_UVX` 指向 `uvx` 的绝对路径。

### CLI 超时或无法连接

确认微信开发者工具“设置 → 安全 → 服务端口”已开启。如果开发者工具不是由 MCP 以 CDP 模式打开，可先关闭它，再通过 `wechat_ide(open)` 重新启动。

### CDP 或自动化连接失败

确认 `wechat_ide(open)` 已启用 CDP，且后续工具使用相同的 CDP 端口；确认 `wechat_automator(start)` 已成功，且后续交互使用相同的自动化端口。端口被占用时，应整条链路一起更换。

## 维护原则

- 仓库配置只描述如何启动，不保存个人机器路径。
- MCP 的工具列表和参数以运行时 schema 为准，文档只保留稳定流程和安全边界。
- 启动逻辑统一维护在 `scripts/start-wechat-devtools-mcp.mjs`，避免多个客户端配置逐渐不一致。
- MCP 版本集中固定在启动器中；升级时核对上游工具 schema，执行环境检查和运行态探针，各客户端配置无需改动。

上游建议同时安装配套 `wechat-devtools` Skill，以获得完整 SOP 和故障手册。本仓库的 MCP 连接不依赖该 Skill，项目约定由 `AGENTS.md` 和本文维护；需要上游完整工作流时，按上游 README 安装即可。

## 参考资料

- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)
- [`wechat-devtools-mcp` 项目文档](https://github.com/WaterTian/wechat-devtools-mcp)
