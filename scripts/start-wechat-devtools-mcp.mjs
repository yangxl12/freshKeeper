import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpPackage = "wechat-devtools-mcp==0.9.18";

function existingFile(candidate) {
  return candidate && existsSync(candidate) && statSync(candidate).isFile()
    ? resolve(candidate)
    : undefined;
}

function commandFromRegistry(key) {
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `chcp 65001>nul & reg.exe query ${key} /ve`],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0) return undefined;

  const command = result.stdout.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim();
  if (!command) return undefined;

  const executable =
    command.match(/^"([^"]+\.exe)"/i)?.[1] ?? command.match(/^(.+?\.exe)\b/i)?.[1];
  return executable ? existingFile(join(dirname(executable), "cli.bat")) : undefined;
}

function findWechatCli() {
  const configured = process.env.WECHAT_DEVTOOLS_CLI;
  if (configured) {
    const resolved = existingFile(configured);
    if (!resolved) {
      throw new Error(`WECHAT_DEVTOOLS_CLI 指向的文件不存在：${configured}`);
    }
    return resolved;
  }

  if (process.platform === "darwin") {
    return existingFile("/Applications/wechatwebdevtools.app/Contents/MacOS/cli");
  }

  if (process.platform !== "win32") return undefined;

  const registryKeys = [
    "HKCU\\Software\\Classes\\wechatide\\shell\\open\\command",
    "HKLM\\Software\\Classes\\wechatide\\shell\\open\\command",
    "HKCR\\wechatide\\shell\\open\\command",
  ];
  for (const key of registryKeys) {
    const cli = commandFromRegistry(key);
    if (cli) return cli;
  }

  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Tencent", "微信web开发者工具", "cli.bat"),
    process.env["ProgramFiles(x86)"] &&
      join(process.env["ProgramFiles(x86)"], "Tencent", "微信web开发者工具", "cli.bat"),
  ];
  return candidates.map(existingFile).find(Boolean);
}

function findUvx() {
  const configured = process.env.WECHAT_MCP_UVX;
  if (configured) {
    if (configured.includes("\\") || configured.includes("/")) {
      const resolved = existingFile(configured);
      if (!resolved) throw new Error(`WECHAT_MCP_UVX 指向的文件不存在：${configured}`);
      return resolved;
    }
    const located = locateCommand(configured);
    if (!located) throw new Error(`无法从 PATH 找到 WECHAT_MCP_UVX：${configured}`);
    return located;
  }

  return locateCommand("uvx");
}

function locateCommand(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
}

function resolveRuntime() {
  if (!existsSync(join(projectRoot, "project.config.json"))) {
    throw new Error(`未在项目根目录找到 project.config.json：${projectRoot}`);
  }

  const cli = findWechatCli();
  if (!cli) {
    throw new Error(
      "未找到微信开发者工具 CLI。请确认已安装开发者工具，或设置 WECHAT_DEVTOOLS_CLI。",
    );
  }

  const uvx = findUvx();
  if (!uvx) {
    throw new Error("未找到 uvx。请先安装 uv，并确保 uvx 可从 PATH 访问。");
  }

  return { cli, projectRoot, uvx };
}

try {
  const runtime = resolveRuntime();

  if (process.argv.includes("--check")) {
    const version = spawnSync(runtime.uvx, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (version.status !== 0) {
      throw new Error(`uvx 无法正常运行：${version.stderr?.trim() || version.error?.message}`);
    }

    process.stdout.write(
      `${JSON.stringify({ ok: true, ...runtime, uvxVersion: version.stdout.trim(), mcpPackage }, null, 2)}\n`,
    );
    process.exit(0);
  }

  const child = spawn(runtime.uvx, ["--from", mcpPackage, "wechat-devtools-mcp"], {
    cwd: runtime.projectRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
      WECHAT_DEVTOOLS_CLI: runtime.cli,
      WECHAT_PROJECT_PATH: runtime.projectRoot,
    },
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (error) => {
    console.error(`启动 wechat-devtools-mcp 失败：${error.message}`);
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }

  child.on("exit", (code) => process.exit(code ?? 1));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
