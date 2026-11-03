import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { startPreviewServer } from "./server.mjs";

// Opt-in cross-origin integration.  The editor stays on its own origin and
// Purism is opened in a separate sidecar origin, so existing editor storage is
// not touched by this launcher.
export const DEFAULT_PORT = 8765;
export const READY_TIMEOUT_MS = 2000;
export const STOP_TIMEOUT_MS = 1500;
const HOST = "127.0.0.1";
const APP_FILES = Object.freeze([
  "index.html",
  "obs_server.py",
  "LICENSE",
  "lib/ag-psd.min.js",
  "lib/app.css",
  "lib/app.js",
  "lib/devices.js",
  "lib/face-features.js",
  "lib/genericparts.js",
  "lib/head-turn.js",
  "lib/obs-sync.js",
  "lib/psd-worker.js",
  "lib/recorder.js",
  "lib/renderer.js",
  "lib/rigger.js",
  "lib/runtime.js"
]);
const OPTIONAL_APP_ASSETS = Object.freeze(["README.md", "sample.psd", "sample2.psd"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 必須由使用者明確提供`);
  return value;
}

async function validatedDirectory(input, name) {
  const root = await realpath(requiredString(input, name)).catch(() => { throw new Error(`${name} 不存在`); });
  if (!(await stat(root)).isDirectory()) throw new Error(`${name} 必須是目錄`);
  return root;
}

async function copyOne(sourceRoot, snapshotRoot, relativePath) {
  const trustedRoot = await realpath(sourceRoot);
  const source = resolve(trustedRoot, relativePath);
  const resolvedSource = await realpath(source).catch(() => { throw new Error(`${sourceRoot} 缺少必要檔案：${relativePath}`); });
  const containment = relative(trustedRoot, resolvedSource);
  if (containment.startsWith("..") || isAbsolute(containment)) throw new Error(`${sourceRoot} 路徑越界：${relativePath}`);
  const info = await lstat(source).catch(() => { throw new Error(`${sourceRoot} 缺少必要檔案：${relativePath}`); });
  if (!info.isFile()) throw new Error(`${sourceRoot} 檔案不是一般檔案：${relativePath}`);
  const target = join(snapshotRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolvedSource, target);
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function copyEditorSnapshot(editorRoot, snapshotRoot, sidecarUrl, sampleRoot) {
  for (const relativePath of APP_FILES) await copyOne(editorRoot, snapshotRoot, relativePath);
  if (sampleRoot !== undefined) {
    const samples = await validatedDirectory(sampleRoot, "sample-root");
    try {
      for (const relativePath of OPTIONAL_APP_ASSETS) await copyOne(samples, snapshotRoot, relativePath);
    } catch (error) {
      throw new Error(`sample-root 僅接受 README.md、sample.psd、sample2.psd；使用者指定的兩個 PSD 會被複製到本機暫存並經 loopback 可存取，程式不判斷是否私人：${error.message}`);
    }
  }
  const indexPath = join(snapshotRoot, "index.html");
  const original = await readFile(indexPath, "utf8");
  if ((original.match(/<\/header>/g) ?? []).length !== 1) throw new Error("快照 index.html 缺少唯一 header marker");
  const href = `${sidecarUrl}/directory-preview.html`;
  const link = `<a id="purism-sidecar-link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">官方 model3 預覽</a>`;
  await writeFile(indexPath, original.replace("</header>", `${link}</header>`), "utf8");
}

function waitForChild(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function waitForProcessReady(child, expectedUrl) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    let errorOutput = "";
    let timer;
    const cleanup = (completion) => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      completion();
    };
    const onStdout = (chunk) => {
      output += chunk;
      if (output.includes(`Anime2.5DRig OBS server: ${expectedUrl}`)) cleanup(resolveReady);
    };
    const onStderr = (chunk) => { errorOutput += chunk; };
    const onError = (error) => cleanup(() => rejectReady(error));
    const onExit = (code, signal) => cleanup(() => rejectReady(new Error(`OBS relay child failed before trusted bind signal (code=${code}, signal=${signal}): ${errorOutput.trim() || output.trim()}`)));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => cleanup(() => rejectReady(new Error(`OBS relay readiness timeout after ${READY_TIMEOUT_MS}ms: ${errorOutput.trim() || output.trim()}`))), READY_TIMEOUT_MS);
  });
}

function assertChildRunning(child) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`OBS relay child 已退出（code=${child.exitCode}, signal=${child.signalCode}）`);
}

async function waitForRelay(url, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    assertChildRunning(child);
    try {
      const response = await fetch(new URL("relay-info", url), { cache: "no-store", headers: { connection: "close" }, signal: AbortSignal.timeout(100) });
      if (response.ok) {
        assertChildRunning(child);
        return;
      }
    } catch {
      // The Python server may need a few milliseconds after bind.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("OBS relay server 啟動逾時");
}

async function stopChild(child) {
  // spawn(2) can emit ENOENT before a PID exists.  There is no process to
  // stop or await in that case; let the original spawn error propagate while
  // allowing the caller to clean its own sidecar and snapshot.
  if (child.pid == null) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    waitForChild(child),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), STOP_TIMEOUT_MS))
  ]);
  if (exited !== false || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGKILL");
  const killed = await Promise.race([
    waitForChild(child),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), STOP_TIMEOUT_MS))
  ]);
  if (killed === false && child.exitCode === null && child.signalCode === null) throw new Error("OBS relay child 停止狀態無法確認；保留 snapshot");
  return true;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}

export async function findFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, HOST, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function createOwnedSnapshot(snapshotRoot) {
  if (snapshotRoot === undefined) {
    const path = await mkdtemp(join(tmpdir(), "purism-editor-snapshot-"));
    const info = await lstat(path);
    return { path, owned: true, device: info.dev, inode: info.ino };
  }
  const requested = resolve(requiredString(snapshotRoot, "snapshot-root"));
  try {
    await lstat(requested);
    throw new Error("snapshot-root 已存在；為避免刪除使用者資料，請改用不存在的路徑");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(requested, { recursive: false, mode: 0o700 });
  const info = await lstat(requested);
  return { path: requested, owned: true, device: info.dev, inode: info.ino };
}

async function cleanupOwnedSnapshot(snapshot) {
  if (!snapshot?.owned) return;
  const current = await lstat(snapshot.path).catch(() => { throw new Error("snapshot ownership 已失效；原路徑不存在，拒絕刪除"); });
  if (!current.isDirectory() || current.dev !== snapshot.device || current.ino !== snapshot.inode) {
    throw new Error("snapshot ownership 已失效；device/inode 不符，拒絕刪除");
  }
  await rm(snapshot.path, { recursive: true, force: true });
}

function cleanupFailure(startupError, snapshotPath, cleanupErrors, snapshotCleaned) {
  const primary = startupError instanceof Error ? startupError : new Error(String(startupError));
  const details = cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join(" | ");
  const status = snapshotCleaned ? `snapshot 已清理：${snapshotPath}` : `snapshot 保留或狀態不確定：${snapshotPath}`;
  const failure = new Error(`${primary.message}; cleanup failed: ${details}; ${status}`);
  failure.cause = primary;
  failure.code = "EDITOR_INTEGRATION_CLEANUP_FAILED";
  failure.cleanupErrors = cleanupErrors;
  failure.snapshotRoot = snapshotPath;
  failure.snapshotCleaned = snapshotCleaned;
  return failure;
}

export async function startEditorIntegration({ editorRoot, runtimeRoot, snapshotRoot, sampleRoot, port = DEFAULT_PORT, python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3") } = {}) {
  const editor = await validatedDirectory(editorRoot, "editor-root");
  const runtime = await validatedDirectory(runtimeRoot, "runtime-root");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port 必須是 1..65535；既有埠被占用時直接失敗");
  const snapshot = await createOwnedSnapshot(snapshotRoot);
  let sidecar;
  let child;
  try {
    sidecar = await startPreviewServer({ runtimeRoot: runtime, port: 0 });
    const sidecarUrl = `http://${HOST}:${sidecar.port}`;
    await copyEditorSnapshot(editor, snapshot.path, sidecarUrl, sampleRoot);
    child = spawn(python, ["-u", join(snapshot.path, "obs_server.py"), "--port", String(port)], {
      cwd: snapshot.path,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const hostUrl = `http://${HOST}:${port}/`;
    await waitForProcessReady(child, hostUrl);
    await waitForRelay(hostUrl, child);
    let closeInFlight;
    let closed = false;
    let childStopped = child.exitCode !== null || child.signalCode !== null;
    let sidecarClosed = false;
    let snapshotCleaned = false;
    return Object.freeze({
      hostUrl,
      sidecarUrl,
      snapshotRoot: snapshot.path,
      port,
      sidecarPort: sidecar.port,
      obsProcess: child,
      async close() {
        if (closed) return;
        if (closeInFlight) return closeInFlight;
        closeInFlight = (async () => {
          let failure;
          if (!childStopped) {
            try { await stopChild(child); childStopped = true; } catch (error) { failure = error; }
          }
          if (!sidecarClosed) {
            try { await closeServer(sidecar.server); sidecarClosed = true; } catch (error) { failure ??= error; }
          }
          if (childStopped && !snapshotCleaned) {
            try { await cleanupOwnedSnapshot(snapshot); snapshotCleaned = true; } catch (error) { failure ??= error; }
          } else if (!childStopped) {
            failure ??= new Error("OBS relay child 停止狀態無法確認；保留 snapshot");
          }
          if (failure) throw failure;
          closed = true;
        })();
        try {
          return await closeInFlight;
        } finally {
          closeInFlight = undefined;
        }
      }
    });
  } catch (error) {
    let childStopped = !child;
    let snapshotCleaned = false;
    const cleanupErrors = [];
    if (child) {
      try { await stopChild(child); childStopped = true; } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (sidecar) {
      try { await closeServer(sidecar.server); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (childStopped) {
      try { await cleanupOwnedSnapshot(snapshot); snapshotCleaned = true; } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    } else {
      cleanupErrors.push(new Error("OBS relay child 停止狀態無法確認；保留 snapshot"));
    }
    if (cleanupErrors.length > 0) throw cleanupFailure(error, snapshot.path, cleanupErrors, snapshotCleaned);
    throw error;
  }
}

function printUsage() {
  console.log("用法：node scripts/purism-preview/editor-integration.mjs --editor-root <Anime2.5DRig> --runtime-root <PurismCore Web v1.1.0> [--sample-root <目錄>] [--port 8765] [--snapshot-root <不存在的路徑>] [--python <python>");
  console.log("--sample-root 只取 README.md、sample.psd、sample2.psd；使用者指定的兩個 PSD 會被複製到本機暫存並經 loopback 可存取，程式不判斷是否私人，絕不自動提交 repo。");
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  const portOption = readOption(args, "--port");
  const port = portOption === undefined ? DEFAULT_PORT : Number(portOption);
  try {
    const runtime = await startEditorIntegration({
      editorRoot: readOption(args, "--editor-root"),
      runtimeRoot: readOption(args, "--runtime-root"),
      snapshotRoot: readOption(args, "--snapshot-root"),
      sampleRoot: readOption(args, "--sample-root"),
      port,
      python: readOption(args, "--python") ?? undefined
    });
    console.log(JSON.stringify({ hostUrl: runtime.hostUrl, sidecarUrl: runtime.sidecarUrl, snapshotRoot: runtime.snapshotRoot, relay: true }));
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
