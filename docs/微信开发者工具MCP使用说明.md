# 微信开发者工具 MCP 使用说明

## 基本信息

- 服务名：`wechat-devtools`
- Codex 工具前缀：`mcp__wechat_devtools__`
- Codex 配置：`C:\Users\Administrator\.codex\config.toml` 中的 `[mcp_servers.wechat-devtools]`
- CodeBuddy 配置：`C:\Users\Administrator\.codebuddy\mcp.json` 中的 `mcpServers.wechat-devtools`（需重启或重载 MCP 后生效）
- 启动命令：`uvx wechat-devtools-mcp`
- 安装目录：`C:\Users\Administrator\AppData\Roaming\uv\tools\wechat-devtools-mcp`
- 微信开发者工具 CLI：`D:\微信web开发者工具\cli.bat`
- 本项目路径：`D:\my-project\freshKeeper`

当前全局 `WECHAT_PROJECT_PATH` 指向其他项目。凡支持 `project_path` 的工具都必须显式传入 `D:\my-project\freshKeeper`，不能依赖默认值。

## 调用约定

- 所有工具统一使用 `{"params": {...}}` 传参。
- 默认 CDP 端口为 `9222`，默认自动化端口为 `9420`；同一流程内各工具必须使用一致的端口。
- 运行、调试、交互或界面验证需要该能力时，可直接调用 MCP，无需另行配置。
- `upload` 会上传小程序版本，只有任务明确要求时才使用。

## 常用流程

### 1. 打开项目并启用 CDP

工具：`mcp__wechat_devtools__wechat_ide`

```json
{
  "params": {
    "action": "open",
    "project_path": "D:\\my-project\\freshKeeper",
    "cdp_enabled": true,
    "cdp_port": 9222
  }
}
```

### 2. 启动自动化连接

工具：`mcp__wechat_devtools__wechat_automator`

```json
{
  "params": {
    "action": "start",
    "project_path": "D:\\my-project\\freshKeeper",
    "auto_port": 9420
  }
}
```

### 3. 跳转页面并检查运行时日志

工具：`mcp__wechat_devtools__wechat_navigate`

```json
{
  "params": {
    "page_path": "pages/index/index",
    "project_path": "D:\\my-project\\freshKeeper",
    "auto_port": 9420,
    "cdp_port": 9222,
    "wait_ms": 2000,
    "detail_level": "concise"
  }
}
```

### 4. 截图

工具：`mcp__wechat_devtools__wechat_screenshot`

```json
{
  "params": {
    "page_path": "pages/index/index",
    "auto_port": 9420,
    "full_page": true,
    "output_path": "D:\\my-project\\freshKeeper\\screenshots\\index.png"
  }
}
```

`wechat_screenshot` 没有 `project_path` 参数，必须显式指定本项目下的绝对 `output_path`，避免写入错误的全局默认目录。

### 5. 采集错误和警告

工具：`mcp__wechat_devtools__wechat_inspector`

```json
{
  "params": {
    "action": "cdp",
    "cdp_port": 9222,
    "duration": 10,
    "detail_level": "concise",
    "max_logs": 50
  }
}
```

`action="cdp"` 依赖 `wechat_ide(open)` 时启用 CDP；`action="console"` 依赖 `wechat_automator(start)`。

## 工具与参数

### `wechat_ide`

- 用途：微信开发者工具生命周期管理。
- `action`：`open`、`login`、`is_login`、`close`、`quit`、`status`。
- 常用参数：`project_path`、`appid`、`cdp_enabled`、`cdp_port`、`port`、`lang`。

### `wechat_automator`

- 用途：小程序自动化交互和运行时查询。
- `action`：`start`、`tap`、`input`、`element_info`、`set_data`、`call_method`、`call_wx`、`mock_wx`、`evaluate`、`page_stack`、`page_data`、`system_info`、`storage`。
- `start`：传 `project_path`，可传 `auto_port`、`auto_account`。
- `tap`、`element_info`：必传 `selector`。
- `input`：必传 `selector` 和 `value`。
- `set_data`：必传 `data_json`。
- `call_method`、`call_wx`：必传 `method`，可传 JSON 数组字符串 `args_json`。
- `mock_wx`：必传 `method` 和 JSON 字符串 `result_json`。
- `evaluate`：必传 `expression`。
- `page_data`：可传 `expected_path` 验证当前页面。
- `storage`：可传 `key`；不传时读取全部缓存。

### `wechat_navigate`

- 用途：跳转页面并通过 CDP 采集日志。
- 必传：`page_path`，支持 query 参数。
- 常用参数：`auto_port`、`cdp_port`、`wait_ms`、`timeout`、`detail_level`、`max_logs`、`clear_logs`、`check_data`。

### `wechat_screenshot`

- 用途：截取当前模拟器界面，可生成长图。
- 常用参数：`page_path`、`auto_port`、`full_page`、`scroll_top`、`overlap`、`output_path`。
- 本项目必须显式传绝对 `output_path`。

### `wechat_inspector`

- 用途：采集控制台日志、JavaScript 异常和 CDP 底层日志。
- `action`：`console` 或 `cdp`。
- 常用参数：`duration`、`detail_level`、`max_logs`、`auto_port`、`cdp_port`、`log_type`、`tap_selector`。

### `wechat_build`

- 用途：编译、预览、上传、构建 NPM 和清理缓存。
- `action`：`compile`、`preview`、`upload`、`build_npm`、`cache_clean`。
- 始终显式传 `project_path`。
- `upload` 必传 `version`，可传 `desc`。
- `cache_clean` 可传 `clean_type`：`storage`、`file`、`compile`、`auth`、`network`、`session`、`all`。

### `wechat_file`

- 用途：读取项目结构和源码。
- `action`：`project_info`、`list_pages`、`read_page`、`read_file`。
- 始终显式传 `project_path`。
- `read_page` 必传 `page_path`；`read_file` 必传相对路径 `file_path`。

## 常见问题

- 项目路径错误：检查调用是否显式传入 `D:\my-project\freshKeeper`。
- CDP 连接失败：确认以 `cdp_enabled=true` 打开项目，并检查 `9222` 是否被占用；换端口后同步修改 `wechat_navigate`、`wechat_inspector` 等调用。
- 自动化连接失败：确认已执行 `wechat_automator(action="start")`，并检查各调用的 `auto_port` 是否一致。
- 截图位置错误：始终传入 `D:\my-project\freshKeeper\screenshots\<文件名>.png` 形式的绝对路径。
