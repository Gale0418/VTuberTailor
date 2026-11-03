import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Server, createConnection } from "node:net";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PORT, findFreePort, startEditorIntegration } from "../scripts/purism-preview/editor-integration.mjs";

const AUDITED_RUNTIME_ROOT = process.env.PURISM_RUNTIME_ROOT;
const REQUIRED_RUNTIME_FILES = ["purism-viewer.html", "viewer.js", "viewer.wasm", "LICENSE-PurismCore-MIT"];
let runtimeAvailable = Boolean(AUDITED_RUNTIME_ROOT);
if (runtimeAvailable) {
  for (const name of REQUIRED_RUNTIME_FILES) {
    try { await stat(join(AUDITED_RUNTIME_ROOT, name)); }
    catch { runtimeAvailable = false; }
  }
}
const SKIP_REASON = "set PURISM_RUNTIME_ROOT to a local pin-validated PurismCore Web v1.1.0 directory";

async function writeSyntheticEditor(root) {
  await mkdir(join(root, "lib"));
  const index = "<!doctype html><html><head><title>synthetic Anime2.5DRig</title></head><body><header>editor</header><button data-sample=\"A\">sample2.psd</button><button data-sample=\"B\">sample.psd</button><button id=\"btnReadme\">README.md</button></body></html>";
  const relay = `import argparse\nimport json\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\nparser=argparse.ArgumentParser()\nparser.add_argument('--port', type=int, default=8765)\nargs=parser.parse_args()\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        if self.path == '/relay-info':\n            body=json.dumps({'protocol':'anime25d-relay-v2','features':['tracking','state','model']}).encode()\n            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return\n        try:\n            path=self.path.split('?',1)[0].lstrip('/')\n            with open(path,'rb') as source: body=source.read()\n            self.send_response(200); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)\n        except OSError:\n            self.send_error(404)\n    def log_message(self, *_): pass\nserver=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)\nprint(f'Anime2.5DRig OBS server: http://127.0.0.1:{args.port}/', flush=True)\nserver.serve_forever()\n`;
  await writeFile(join(root, "index.html"), index);
  await writeFile(join(root, "obs_server.py"), relay);
  await writeFile(join(root, "LICENSE"), "MIT License\n");
  for (const name of ["ag-psd.min.js", "app.css", "app.js", "devices.js", "face-features.js", "genericparts.js", "head-turn.js", "obs-sync.js", "psd-worker.js", "recorder.js", "renderer.js", "rigger.js", "runtime.js"]) {
    await writeFile(join(root, "lib", name), `/* synthetic ${name} */\n`);
  }
}

async function writeSyntheticSamples(root) {
  await writeFile(join(root, "sample.psd"), Buffer.from("8BPS\0\x01synthetic-sample", "binary"));
  await writeFile(join(root, "sample2.psd"), Buffer.from("8BPS\0\x01synthetic-sample-2", "binary"));
  await writeFile(join(root, "README.md"), "# synthetic integration fixture\n");
}

async function assertPortClosed(port) {
  await new Promise((resolveClosed, rejectClosed) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); rejectClosed(new Error(`port ${port} still accepts connections`)); });
    socket.once("error", () => resolveClosed());
    socket.once("timeout", () => { socket.destroy(); rejectClosed(new Error(`port ${port} close probe timed out`)); });
  });
}

async function assertMissing(path) {
  await assert.rejects(() => stat(path), /ENOENT/);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

test("missing editor-root fails closed without requiring a Purism runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-no-editor-"));
  const snapshotRoot = join(root, "snapshot");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    startEditorIntegration({ editorRoot: join(root, "does-not-exist-editor"), runtimeRoot: join(root, "does-not-exist-runtime"), snapshotRoot, port: 0 }),
    /editor-root 不存在/
  );
  await assertMissing(snapshotRoot);
});

test("invalid port fails before opening any endpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-invalid-port-"));
  const editorRoot = join(root, "editor");
  const runtimeRoot = join(root, "runtime-directory-only");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(runtimeRoot);
  await writeSyntheticEditor(editorRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot, snapshotRoot, port: 0 }),
    /port 必須/
  );
  await assertMissing(snapshotRoot);
});

test("preexisting snapshot sentinel is never touched without runtime binaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-existing-snapshot-"));
  const editorRoot = join(root, "editor");
  const runtimeRoot = join(root, "runtime-directory-only");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(runtimeRoot);
  await mkdir(snapshotRoot);
  await writeSyntheticEditor(editorRoot);
  await writeFile(join(snapshotRoot, "sentinel"), "keep");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot, snapshotRoot, port: await findFreePort() }),
    /snapshot-root 已存在/
  );
  assert.equal(await readFile(join(snapshotRoot, "sentinel"), "utf8"), "keep");
});

test("invalid runtime cleans a newly owned snapshot and never starts relay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-invalid-runtime-"));
  const editorRoot = join(root, "editor");
  const runtimeRoot = join(root, "runtime-directory-only");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(runtimeRoot);
  await writeSyntheticEditor(editorRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await findFreePort();
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot, snapshotRoot, port }),
    /runtime 檔案不存在/
  );
  await assertMissing(snapshotRoot);
  await assertPortClosed(port);
});

test("cross-origin editor snapshot, sample entry and close lifecycle", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-integration-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(DEFAULT_PORT, 8765);
  const port = await findFreePort();
  const runtime = await startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, port });
  const ownedSnapshot = runtime.snapshotRoot;
  try {
    const host = await fetch(`${runtime.hostUrl}index.html`);
    assert.equal(host.status, 200);
    assert.match(await host.text(), /purism-sidecar-link/);
    for (const name of ["sample.psd", "sample2.psd", "README.md"]) {
      const response = await fetch(`${runtime.hostUrl}${name}`);
      assert.equal(response.status, 200, name);
    }
    assert.equal((await fetch(`${runtime.hostUrl}relay-info`)).status, 200);
    assert.equal((await fetch(`${runtime.sidecarUrl}/directory-preview.html`)).status, 200);
  } finally {
    await runtime.close();
  }
  await assertMissing(ownedSnapshot);
  await assertPortClosed(runtime.port);
  await assertPortClosed(runtime.sidecarPort);
});

test("close is idempotent and concurrent calls share one lifecycle", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-close-idempotent-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = await startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, port: await findFreePort() });
  const ownedSnapshot = runtime.snapshotRoot;
  await Promise.all([runtime.close(), runtime.close()]);
  await runtime.close();
  await assertMissing(ownedSnapshot);
  await assertPortClosed(runtime.port);
  await assertPortClosed(runtime.sidecarPort);
});

test("close retries only incomplete phases after sidecar close failure", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-close-retry-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = await startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, port: await findFreePort() });
  const ownedSnapshot = runtime.snapshotRoot;
  const originalClose = Server.prototype.close;
  let injected = true;
  Server.prototype.close = function closeWithInjectedFailure(callback) {
    if (injected) {
      injected = false;
      queueMicrotask(() => callback(Object.assign(new Error("injected sidecar close failure"), { code: "EINJECTED" })));
      return this;
    }
    return originalClose.call(this, callback);
  };
  try {
    await assert.rejects(runtime.close(), /injected sidecar close failure/);
    await assertMissing(ownedSnapshot);
    await runtime.close();
    await runtime.close();
  } finally {
    Server.prototype.close = originalClose;
  }
  await assertPortClosed(runtime.port);
  await assertPortClosed(runtime.sidecarPort);
});

test("a 200 fake relay cannot satisfy child-owned readiness", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-conflict-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await findFreePort();
  const blocker = await new Promise((resolveListen, rejectListen) => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ protocol: "anime25d-relay-v2", features: ["tracking", "state", "model"] }));
    });
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen(server));
  });
  try {
    await assert.rejects(
      startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot, port }),
      /trusted bind signal/
    );
    await assertMissing(snapshotRoot);
    const response = await fetch(`http://127.0.0.1:${port}/relay-info`);
    assert.equal(response.status, 200);
  } finally {
    blocker.closeAllConnections?.();
    await new Promise((resolveClose, rejectClose) => blocker.close((error) => error ? rejectClose(error) : resolveClose()));
  }

  const existingSnapshot = join(root, "existing-snapshot");
  await mkdir(existingSnapshot);
  await writeFile(join(existingSnapshot, "sentinel"), "keep");
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot: existingSnapshot, port: await findFreePort() }),
    /snapshot-root 已存在/
  );
  assert.equal(await readFile(join(existingSnapshot, "sentinel"), "utf8"), "keep");
});

test("readiness timeout cleans a silent child and its owned snapshot", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-timeout-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  await writeFile(join(editorRoot, "obs_server.py"), "import time\ntime.sleep(60)\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotRoot = join(root, "snapshot");
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot, port: await findFreePort() }),
    /readiness timeout/
  );
  await assertMissing(snapshotRoot);
});

test("parent directory symlink escaping editor-root is rejected and cleaned", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-symlink-"));
  const editorRoot = join(root, "editor");
  const outside = join(root, "outside-lib");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(outside);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  await writeFile(join(outside, "ag-psd.min.js"), "outside");
  await rm(join(editorRoot, "lib"), { recursive: true, force: true });
  await symlink(outside, join(editorRoot, "lib"), "dir");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot, port: await findFreePort() }),
    /路徑越界/
  );
  await assertMissing(snapshotRoot);
});

test("snapshot replacement is never deleted after device/inode mismatch", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-ownership-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  const movedRoot = join(root, "moved-snapshot");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot, port: await findFreePort() });
  runtime.obsProcess.kill("SIGTERM");
  await waitForExit(runtime.obsProcess);
  await rename(snapshotRoot, movedRoot);
  await mkdir(snapshotRoot);
  await writeFile(join(snapshotRoot, "user-sentinel"), "keep");
  await assert.rejects(runtime.close(), /device\/inode 不符/);
  assert.equal(await readFile(join(snapshotRoot, "user-sentinel"), "utf8"), "keep");
});

test("unconfirmed child stop keeps the owned snapshot for recovery", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-stop-failure-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await startEditorIntegration({ editorRoot, runtimeRoot: AUDITED_RUNTIME_ROOT, sampleRoot, snapshotRoot, port: await findFreePort() });
  await writeFile(join(snapshotRoot, "recovery-sentinel"), "keep");
  const originalKill = runtime.obsProcess.kill.bind(runtime.obsProcess);
  runtime.obsProcess.kill = () => false;
  await assert.rejects(runtime.close(), /停止狀態無法確認/);
  assert.equal(await readFile(join(snapshotRoot, "recovery-sentinel"), "utf8"), "keep");
  runtime.obsProcess.kill = originalKill;
  runtime.obsProcess.kill("SIGTERM");
  await waitForExit(runtime.obsProcess);
  await runtime.close();
  await assertMissing(snapshotRoot);
});

test("missing Python executable preserves ENOENT and cleans the unstarted snapshot", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-missing-python-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    startEditorIntegration({
      editorRoot,
      runtimeRoot: AUDITED_RUNTIME_ROOT,
      sampleRoot,
      snapshotRoot,
      port: await findFreePort(),
      python: join(root, "does-not-exist-python")
    }),
    /ENOENT/
  );
  await assertMissing(snapshotRoot);
});

test("startup error reports cleanup failure and retained snapshot", { skip: runtimeAvailable ? false : SKIP_REASON }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-editor-startup-cleanup-error-"));
  const editorRoot = join(root, "editor");
  const sampleRoot = join(root, "samples");
  const snapshotRoot = join(root, "snapshot");
  const movedRoot = join(root, "moved-snapshot");
  await mkdir(editorRoot);
  await mkdir(sampleRoot);
  await writeSyntheticEditor(editorRoot);
  await writeSyntheticSamples(sampleRoot);
  t.after(() => rm(root, { recursive: true, force: true }));

  const port = await findFreePort();
  const originalClose = Server.prototype.close;
  let injected = true;
  Server.prototype.close = function closeWithCleanupFailure(callback) {
    if (injected) {
      injected = false;
      renameSync(snapshotRoot, movedRoot);
      mkdirSync(snapshotRoot);
      writeFileSync(join(snapshotRoot, "retained-sentinel"), "keep");
      return originalClose.call(this, () => callback(Object.assign(new Error("injected sidecar cleanup failure"), { code: "EINJECTED" })));
    }
    return originalClose.call(this, callback);
  };
  try {
    await assert.rejects(
      startEditorIntegration({
        editorRoot,
        runtimeRoot: AUDITED_RUNTIME_ROOT,
        sampleRoot,
        snapshotRoot,
        port,
        python: join(root, "does-not-exist-python")
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_INTEGRATION_CLEANUP_FAILED");
        assert.match(error.message, /ENOENT/);
        assert.match(error.message, /cleanup failed: injected sidecar cleanup failure/);
        assert.match(error.message, /snapshot 保留或狀態不確定/);
        assert.match(error.message, new RegExp(snapshotRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(error.cause?.code, "ENOENT");
        assert.equal(error.snapshotCleaned, false);
        return true;
      }
    );
    assert.equal(await readFile(join(snapshotRoot, "retained-sentinel"), "utf8"), "keep");
  } finally {
    Server.prototype.close = originalClose;
  }
});
