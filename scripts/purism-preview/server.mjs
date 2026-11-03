import { createHash } from "node:crypto";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { realpath, readFile, open, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WRAPPER_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REQUIRED_RUNTIME_VERSION = "1.1.0";
export const MAX_RUNTIME_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_TOTAL_BYTES = 32 * 1024 * 1024;

const RUNTIME_FILES = Object.freeze(["purism-viewer.html", "viewer.js", "viewer.wasm"]);
const RUNTIME_LICENSE = "LICENSE-PurismCore-MIT";
const VALIDATED_RUNTIME = Symbol("validated PurismCore runtime");
const RUNTIME_SNAPSHOTS = new WeakMap();
// Fixed hashes are from the locally audited PurismCore Web v1.1.0 runtime.
// A runtime-root manifest is unnecessary; fixed hashes are the trust anchor.
const TRUSTED_RUNTIME_HASHES = Object.freeze({
  "purism-viewer.html": "25da19ab44d0074f61c46a7cbafb7e7256bf8776e523219cbae43a8a210c3d5d",
  "viewer.js": "f4eaa47ca64627c5974ec531fcbb3494301146a278946909f847b87f7d3fc011",
  "viewer.wasm": "6daaa2e8ea4ceea51fef8b1796ebacf56a7064c8cc04f3426522624c90ea9f90",
  "LICENSE-PurismCore-MIT": "0c420f717a04a7bbc4cd3c652c83e77d0d7883a14b363d60af94ff6cdf3b7768"
});
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"]
]);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

function fail(message, code = "INVALID_RUNTIME") {
  throw Object.assign(new Error(`[purism-preview] ${message}`), { code });
}

function outsideRoot(rootPath, targetPath) {
  const child = relative(rootPath, targetPath);
  return child.startsWith("..") || isAbsolute(child);
}

async function containedFile(rootPath, relativePath, { maxBytes = MAX_RUNTIME_FILE_BYTES } = {}) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\") || relativePath.includes("/") || basename(relativePath) !== relativePath)
    fail(`runtime 檔名必須是單一 basename：${relativePath}`);
  const lexical = resolve(rootPath, relativePath);
  if (outsideRoot(rootPath, lexical)) fail(`runtime 路徑越界：${relativePath}`);
  const target = await realpath(lexical).catch(() => fail(`runtime 檔案不存在：${relativePath}`, "MISSING_RUNTIME"));
  if (outsideRoot(rootPath, target)) fail(`runtime symlink 越界：${relativePath}`);
  const info = await stat(target);
  if (!info.isFile()) fail(`runtime 不是檔案：${relativePath}`);
  if (info.size > maxBytes) fail(`runtime 檔案過大：${relativePath}`);
  return { target, size: info.size };
}

async function readStableFile(path, maxBytes) {
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("runtime 不是檔案");
    if (info.size > maxBytes) fail("runtime 檔案過大");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== info.size) fail("runtime 檔案大小在讀取時改變");
    return { bytes, size: info.size };
  } finally {
    await handle.close();
  }
}

function requireHash(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail(`${name} 必須是 SHA-256 hex`);
  return value.toLowerCase();
}

/**
 * Validate a user-supplied runtime before opening any HTTP endpoint.
 * Arbitrary HTML/JS/WASM is rejected instead of being trusted merely because
 * it is under runtime-root.
 */
async function validateRuntimeRootInternal(runtimeRoot, trustedHashes) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.trim() === "") fail("必須提供 --runtime-root");
  const root = await realpath(resolve(runtimeRoot)).catch(() => fail("runtime-root 不存在", "MISSING_RUNTIME"));
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) fail("runtime-root 必須是目錄");

  const expectedFileNames = [...RUNTIME_FILES, RUNTIME_LICENSE].sort();

  const validatedFiles = {};
  const snapshotFiles = {};
  let totalBytes = 0;
  for (const fileName of expectedFileNames) {
    const file = await containedFile(root, fileName);
    const stable = await readStableFile(file.target, MAX_RUNTIME_FILE_BYTES);
    totalBytes += stable.size;
    if (totalBytes > MAX_RUNTIME_TOTAL_BYTES) fail("runtime 總大小超過限制");
    const actualHash = createHash("sha256").update(stable.bytes).digest("hex");
    const trustedHash = requireHash(trustedHashes[fileName], `trusted.${fileName}`);
    if (actualHash !== trustedHash) fail(`runtime hash 不符：${fileName}`);
    validatedFiles[fileName] = Object.freeze({ path: file.target, size: stable.size, sha256: actualHash });
    snapshotFiles[fileName] = stable.bytes;
  }
  const licenseText = snapshotFiles[RUNTIME_LICENSE].toString("utf8");
  if (!/^MIT License\s/m.test(licenseText) || !/Permission is hereby granted/m.test(licenseText)) fail("Purism runtime license 不是可核對的 MIT 文字");
  const result = Object.freeze({ [VALIDATED_RUNTIME]: true, root, files: Object.freeze(validatedFiles) });
  RUNTIME_SNAPSHOTS.set(result, Object.freeze(snapshotFiles));
  return result;
}

export async function validateRuntimeRoot(runtimeRoot) {
  return validateRuntimeRootInternal(runtimeRoot, TRUSTED_RUNTIME_HASHES);
}

async function readWrapperFile(pathname) {
  const allowed = new Set(["/", "/directory-preview.html", "/client.mjs", "/client-state.mjs", "/import-policy.mjs"]);
  if (!allowed.has(pathname)) return null;
  const fileName = pathname === "/" ? "directory-preview.html" : pathname.slice(1);
  const target = resolve(WRAPPER_ROOT, fileName);
  const realRoot = await realpath(WRAPPER_ROOT);
  const realTarget = await realpath(target);
  if (outsideRoot(realRoot, realTarget)) fail("wrapper path escaped", "FORBIDDEN");
  const info = await stat(realTarget);
  if (!info.isFile()) return null;
  return { target: realTarget, info };
}

function responseHeaders(pathname) {
  return {
    "Content-Type": CONTENT_TYPES.get(extname(pathname).toLowerCase()) ?? "application/octet-stream",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  };
}

export function createPreviewServer(validatedRuntime) {
  const snapshot = validatedRuntime && RUNTIME_SNAPSHOTS.get(validatedRuntime);
  if (!validatedRuntime?.[VALIDATED_RUNTIME] || !validatedRuntime.root || !validatedRuntime.files || !snapshot) throw new TypeError("createPreviewServer 需要 validateRuntimeRoot 結果");
  const runtimeByName = new Map(Object.entries(validatedRuntime.files).map(([name, metadata]) => [name, { ...metadata, content: snapshot[name] }]));
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.search) fail("禁止 runtime/query model URL", "FORBIDDEN");
      const pathname = decodeURIComponent(url.pathname);
      let file;
      if (pathname.startsWith("/runtime/")) {
        const name = pathname.slice("/runtime/".length);
        if (name.includes("/") || !runtimeByName.has(name) || name === RUNTIME_LICENSE) fail("runtime asset 不在明確 allowlist", "FORBIDDEN");
        file = runtimeByName.get(name);
      } else {
        file = await readWrapperFile(pathname);
      }
      if (!file) {
        response.writeHead(404, { ...responseHeaders(pathname), "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      const body = file.content ?? await readFile(file.target);
      response.writeHead(200, responseHeaders(pathname === "/" ? "/directory-preview.html" : pathname));
      response.end(body);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error.code === "FORBIDDEN" ? 403 : 404;
      response.writeHead(status, { ...responseHeaders(".txt"), "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
}

export async function startPreviewServer({ runtimeRoot, port = 0 } = {}) {
  const runtime = await validateRuntimeRoot(runtimeRoot);
  const server = createPreviewServer(runtime);
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    fail("無法取得 loopback port");
  }
  return Object.freeze({ server, runtime, host: "127.0.0.1", port: address.port, url: `http://127.0.0.1:${address.port}/directory-preview.html` });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--runtime-root");
  const portIndex = args.indexOf("--port");
  const runtimeRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("用法：node scripts/purism-preview/server.mjs --runtime-root <PurismCore Web v1.1.0 目錄> [--port 0]");
    process.exitCode = 2;
  } else {
    startPreviewServer({ runtimeRoot, port }).then(({ url, server }) => {
      console.log(JSON.stringify({ url, loopback: true, staticOnly: true, physics: false, motion: false, vts: false }));
      let closing = false;
      const closeOwnServer = () => {
        if (closing) return;
        closing = true;
        server.closeAllConnections?.();
        server.close(() => process.exit(0));
      };
      process.once("SIGINT", closeOwnServer);
      process.once("SIGTERM", closeOwnServer);
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
