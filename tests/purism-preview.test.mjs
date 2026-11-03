import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  mergeMultiFileSelection,
  model3ReferencedPaths,
  prepareDirectoryEntries,
  prepareMultiFileEntries,
  selectReferencedEntries
} from "../scripts/purism-preview/import-policy.mjs";
import { createPreviewServer, validateRuntimeRoot } from "../scripts/purism-preview/server.mjs";
import {
  canCommitViewerStatus,
  isCurrentViewerContext,
  replaceViewerModel,
  shouldHandleFrameLoad,
  transitionAfterViewerReload,
  transitionAfterFrameLoad
} from "../scripts/purism-preview/client-state.mjs";

const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

function fileLike(name, bytes, relativePath = name) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return {
    name,
    webkitRelativePath: relativePath,
    size: data.byteLength,
    text: async () => new TextDecoder().decode(data),
    arrayBuffer: async () => data.slice().buffer
  };
}

async function writeRuntime(root) {
  const contents = {
    "purism-viewer.html": "<!doctype html><script src=\"viewer.js\"></script>",
    "viewer.js": "globalThis.__syntheticPurismViewer = true;",
    "viewer.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    "LICENSE-PurismCore-MIT": MIT
  };
  for (const [name, value] of Object.entries(contents)) await writeFile(join(root, name), value);
}

const AUDITED_RUNTIME_SOURCE = process.env.PURISM_PREVIEW_TEST_RUNTIME ? resolve(process.env.PURISM_PREVIEW_TEST_RUNTIME) : undefined;
const AUDITED_RUNTIME_FILES = ["purism-viewer.html", "viewer.js", "viewer.wasm", "LICENSE-PurismCore-MIT"];
let auditedRuntimeAvailable = Boolean(AUDITED_RUNTIME_SOURCE);
if (auditedRuntimeAvailable) {
  for (const name of AUDITED_RUNTIME_FILES) {
    try { await stat(join(AUDITED_RUNTIME_SOURCE, name)); }
    catch { auditedRuntimeAvailable = false; }
  }
}

async function stageAuditedRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "purism-preview-audited-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of AUDITED_RUNTIME_FILES) {
    await copyFile(join(AUDITED_RUNTIME_SOURCE, name), join(root, name));
  }
  return root;
}

test("model3 policy requires valid references and exact case", async () => {
  const model = { FileReferences: { Moc: "nested/avatar.moc3", Textures: ["textures/face.png"], Physics: "nested/avatar.physics3.json" } };
  const files = [
    fileLike("avatar.model3.json", JSON.stringify(model), "root/avatar.model3.json"),
    fileLike("avatar.moc3", "moc", "root/nested/avatar.moc3"),
    fileLike("face.png", "png", "root/textures/face.png"),
    fileLike("avatar.physics3.json", "physics", "root/nested/avatar.physics3.json"),
    fileLike("README.md", "ignored", "root/README.md")
  ];
  const manifest = prepareDirectoryEntries(files);
  const selected = selectReferencedEntries(manifest, model);
  assert.deepEqual([...selected.referencedPaths].sort(), ["avatar.model3.json", "nested/avatar.moc3", "nested/avatar.physics3.json", "textures/face.png"].sort());
  assert.throws(() => selectReferencedEntries(manifest, { FileReferences: { Moc: "Nested/avatar.moc3", Textures: ["textures/face.png"] } }), /大小寫不符/);
  assert.throws(() => model3ReferencedPaths({ FileReferences: { Moc: "avatar.moc3", Textures: [] } }), /Textures/);
  assert.deepEqual(
    model3ReferencedPaths({ FileReferences: {
      Moc: "avatar.moc3",
      Textures: ["face.png"],
      Physics: "",
      Pose: "",
      DisplayInfo: "",
      UserData: "",
      Expressions: [{ File: "" }],
      Motions: { Idle: [{ File: "" }] }
    } }),
    ["avatar.moc3", "face.png"]
  );
  assert.throws(() => prepareDirectoryEntries(files, { maxFiles: 2, maxTotalBytes: 9999, maxFileBytes: 9999 }), /輸入檔案數/);
});

test("multi-file fallback accumulates batches but rejects duplicate or ambiguous basenames", async () => {
  const model = JSON.stringify({ FileReferences: { Moc: "nested/avatar.moc3", Textures: ["textures/face.png"] } });
  const first = [fileLike("avatar.model3.json", model), fileLike("avatar.moc3", "moc")];
  const second = [fileLike("face.png", "png")];
  assert.equal(mergeMultiFileSelection(first, second).length, 3);
  const selected = await prepareMultiFileEntries([...first, ...second]);
  assert.deepEqual([...selected.referencedPaths].sort(), ["avatar.model3.json", "nested/avatar.moc3", "textures/face.png"].sort());
  assert.throws(() => mergeMultiFileSelection(first, [fileLike("AVATAR.MOC3", "duplicate")]), /basename 重複/);
  const ambiguous = [
    fileLike("avatar.model3.json", JSON.stringify({ FileReferences: { Moc: "one/avatar.moc3", Textures: ["face.png"], Physics: "two/avatar.moc3" } })),
    fileLike("avatar.moc3", "one"), fileLike("face.png", "face")
  ];
  await assert.rejects(() => prepareMultiFileEntries(ambiguous), /basename 不唯一|缺失/);
});

test("fixed runtime pin is fail-closed and server exposes only dynamic loopback allowlist", { skip: auditedRuntimeAvailable ? false : "set PURISM_PREVIEW_TEST_RUNTIME to an audited PurismCore v1.1.0 directory" }, async (t) => {
  const root = await stageAuditedRuntime(t);
  const runtime = await validateRuntimeRoot(root);
  const server = createPreviewServer(runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const started = { server, host: "127.0.0.1", port: server.address().port };
  let closed = false;
  const closeServer = () => new Promise((resolve) => {
    started.server.closeAllConnections?.();
    started.server.close(() => { closed = true; resolve(); });
  });
  t.after(() => closed ? undefined : closeServer());
  assert.equal(started.host, "127.0.0.1");
  assert.ok(started.port > 0);
  const base = `http://${started.host}:${started.port}`;
  const rootPage = await fetch(`${base}/`);
  assert.equal(rootPage.status, 200);
  assert.match(rootPage.headers.get("content-type"), /^text\/html/);
  const page = await fetch(`${base}/directory-preview.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await page.text(), /分批選擇 model3/);
  for (const wrapperImport of ["client.mjs", "client-state.mjs", "import-policy.mjs"]) {
    const imported = await fetch(`${base}/${wrapperImport}`);
    assert.equal(imported.status, 200, wrapperImport);
    assert.match(imported.headers.get("content-type"), /^text\/javascript/);
  }
  assert.equal((await fetch(`${base}/runtime/viewer.wasm`)).status, 200);
  const originalViewer = await readFile(join(root, "viewer.js"), "utf8");
  await writeFile(join(root, "viewer.js"), "replacement after validation");
  assert.equal(await (await fetch(`${base}/runtime/viewer.js`)).text(), originalViewer);
  assert.equal((await fetch(`${base}/runtime/LICENSE-PurismCore-MIT`)).status, 403);
  assert.equal((await fetch(`${base}/runtime/unlisted.js`)).status, 403);
  assert.equal((await fetch(`${base}/runtime/purism-viewer.html?model=https%3A%2F%2Fexample.invalid`)).status, 403);
  assert.equal((await fetch(`${base}/private-model.json`)).status, 404);
  await closeServer();
  await assert.rejects(() => fetch(`${base}/directory-preview.html`));
});

test("fixed runtime hash and realpath checks fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "purism-preview-invalid-"));
  const outside = await mkdtemp(join(tmpdir(), "purism-preview-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeRuntime(root);
  await writeFile(join(outside, "LICENSE-PurismCore-MIT"), "external");
  await rm(join(root, "LICENSE-PurismCore-MIT"));
  await symlink(join(outside, "LICENSE-PurismCore-MIT"), join(root, "LICENSE-PurismCore-MIT"));
  await assert.rejects(() => validateRuntimeRoot(root), /symlink 越界/);
});

test("server constructor rejects forged validation results", () => {
  assert.throws(() => createPreviewServer({ root: "/tmp", files: {} }), /validateRuntimeRoot/);
});

test("client readiness state rejects stale frame promises and accepts only current boot", () => {
  const boot = { viewerGeneration: 2, generation: 4, loadInFlight: false, statusState: "booting" };
  assert.equal(canCommitViewerStatus(boot, { viewerGeneration: 2, generation: 4 }), true);
  assert.equal(canCommitViewerStatus(boot, { viewerGeneration: 1, generation: 3 }), false);
  assert.equal(canCommitViewerStatus({ ...boot, viewerGeneration: 3, statusState: "error" }, { viewerGeneration: 2, generation: 4 }), false);
  assert.equal(canCommitViewerStatus({ ...boot, loadInFlight: true }, { viewerGeneration: 2, generation: 4 }), false);
});

test("client initialization handles a lost initial load and deduplicates the later event", () => {
  const firstDocument = { readyState: "complete" };
  const reloadedDocument = { readyState: "complete" };
  assert.equal(shouldHandleFrameLoad(undefined, firstDocument), true, "已完成 document 應可補初始化");
  assert.equal(shouldHandleFrameLoad(firstDocument, firstDocument), false, "補初始化後的同一 load event 不應重複");
  assert.equal(shouldHandleFrameLoad(firstDocument, reloadedDocument), true, "新 document reload 應重新初始化");
});

test("iframe reload resets stale success state and invalidates detached viewer context", () => {
  assert.equal(transitionAfterFrameLoad({ statusState: "error", loadInFlight: false }).statusState, "error", "first document ready 不得覆蓋既有錯誤");
  assert.equal(transitionAfterFrameLoad({ statusState: "request-submitted", loadInFlight: false }, { hasPreviousDocument: true }).statusState, "booting");
  assert.equal(transitionAfterFrameLoad({ statusState: "loading", loadInFlight: true }, { hasPreviousDocument: true }).statusState, "loading");
  const oldDocument = {};
  const oldWindow = {};
  const current = { viewerGeneration: 3, document: {}, window: {} };
  assert.equal(isCurrentViewerContext(current, { viewerGeneration: 2, document: oldDocument, window: oldWindow }), false);
  assert.equal(isCurrentViewerContext(current, { viewerGeneration: 3, document: current.document, window: current.window }), true);
  assert.equal(isCurrentViewerContext(current, { viewerGeneration: 3, document: current.document, window: {} }), false, "WindowProxy 變動也必須失效");
});

test("viewer reload advances load generation and cancels detached load state", () => {
  assert.deepEqual(
    transitionAfterViewerReload({ generation: 4, loadInFlight: true, statusState: "loading" }, { hasPreviousDocument: true }),
    { generation: 5, loadInFlight: false, statusState: "booting" }
  );
  assert.deepEqual(
    transitionAfterViewerReload({ generation: 4, loadInFlight: false, statusState: "request-submitted" }),
    { generation: 4, loadInFlight: false, statusState: "request-submitted" }
  );
});

function createMemoryFs({ failWrite, failRename, failUnlink, failRmdir } = {}) {
  const DIRECTORY = 0x4000;
  const directories = new Set(["/"]);
  const files = new Map();
  const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
  const has = (path) => directories.has(path) || files.has(path);
  const childrenOf = (path) => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = new Set();
    for (const candidate of [...directories, ...files.keys()]) {
      if (!candidate.startsWith(prefix) || candidate === path) continue;
      const rest = candidate.slice(prefix.length);
      if (rest && !rest.includes("/")) children.add(rest);
    }
    return [...children];
  };
  return {
    mkdir(path) {
      if (has(path)) throw new Error(`EEXIST ${path}`);
      if (!directories.has(parentOf(path))) throw new Error(`ENOENT ${path}`);
      directories.add(path);
    },
    stat(path) {
      if (directories.has(path)) return { mode: DIRECTORY };
      if (files.has(path)) return { mode: 0x8000 };
      throw new Error(`ENOENT ${path}`);
    },
    isDir(mode) { return mode === DIRECTORY; },
    readdir(path) { return [".", "..", ...childrenOf(path)]; },
    rmdir(path) {
      if (failRmdir?.(path)) throw new Error(`injected rmdir failure: ${path}`);
      if (childrenOf(path).length) throw new Error(`ENOTEMPTY ${path}`);
      directories.delete(path);
    },
    unlink(path) {
      if (failUnlink?.(path)) throw new Error(`injected unlink failure: ${path}`);
      if (!files.delete(path)) throw new Error(`ENOENT ${path}`);
    },
    writeFile(path, bytes) {
      if (failWrite?.(path)) throw new Error(`injected write failure: ${path}`);
      if (!directories.has(parentOf(path))) throw new Error(`ENOENT ${path}`);
      files.set(path, new Uint8Array(bytes));
    },
    rename(from, to) {
      if (failRename?.(from, to)) throw new Error(`injected rename failure: ${from} -> ${to}`);
      if (!has(from) || has(to)) throw new Error(`rename failed: ${from} -> ${to}`);
      if (!directories.has(parentOf(to))) throw new Error(`ENOENT ${to}`);
      const dirEntries = [...directories].filter((path) => path === from || path.startsWith(`${from}/`)).sort((a, b) => a.length - b.length);
      const fileEntries = [...files.keys()].filter((path) => path === from || path.startsWith(`${from}/`));
      for (const path of dirEntries) { directories.delete(path); directories.add(to + path.slice(from.length)); }
      for (const path of fileEntries) { const bytes = files.get(path); files.delete(path); files.set(to + path.slice(from.length), bytes); }
    },
    seed(path, bytes) {
      const parent = parentOf(path);
      if (!directories.has(parent)) this.mkdir(parent);
      files.set(path, new TextEncoder().encode(bytes));
    },
    read(path) { return new TextDecoder().decode(files.get(path)); },
    paths() { return [...directories, ...files.keys()].sort(); }
  };
}

test("viewer model replacement commits normally and removes the old model", async () => {
  const FS = createMemoryFs();
  FS.seed("/model/old.txt", "old");
  const result = await replaceViewerModel({
    FS,
    token: "normal",
    entries: [{ relativePath: "nested/new.bin" }],
    readBytes: async () => new TextEncoder().encode("new").buffer
  });
  assert.equal(result.oldModelCleanupError, null);
  assert.equal(FS.read("/model/nested/new.bin"), "new");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/nested", "/model/nested/new.bin"]);
});

test("viewer read failure preserves the old model and cleans staging", async () => {
  const FS = createMemoryFs();
  FS.seed("/model/old.txt", "old");
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "read-failure",
      entries: [{ relativePath: "new.bin" }],
      readBytes: async () => { throw new Error("injected read failure"); }
    }),
    /injected read failure/
  );
  assert.equal(FS.read("/model/old.txt"), "old");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/old.txt"]);
});

test("viewer write failure preserves the old model and cleans staging", async () => {
  const FS = createMemoryFs({ failWrite: (path) => path.endsWith("bad.bin") });
  FS.seed("/model/old.txt", "old");
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "write-failure",
      entries: [{ relativePath: "bad.bin" }],
      readBytes: async () => new TextEncoder().encode("new").buffer
    }),
    /injected write failure/
  );
  assert.equal(FS.read("/model/old.txt"), "old");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/old.txt"]);
});

test("iframe rebuild during staging aborts before commit in the detached context", async () => {
  const FS = createMemoryFs();
  FS.seed("/model/old.txt", "old");
  let checks = 0;
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "iframe-reload",
      entries: [{ relativePath: "new.bin" }],
      readBytes: async () => new TextEncoder().encode("new").buffer,
      assertCurrent: () => { if (++checks > 1) throw new Error("viewer 已重新載入，目前模型載入已取消"); }
    }),
    /viewer 已重新載入/
  );
  assert.equal(FS.read("/model/old.txt"), "old");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/old.txt"]);
});

test("viewer directory swap rolls back when installing the staged model fails", async () => {
  let failOnce = true;
  const FS = createMemoryFs({ failRename: (_from, to) => {
    if (to !== "/model" || !failOnce) return false;
    failOnce = false;
    return true;
  } });
  FS.seed("/model/old.txt", "old");
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "swap-failure",
      entries: [{ relativePath: "new.bin" }],
      readBytes: async () => new TextEncoder().encode("new").buffer
    }),
    /injected rename failure/
  );
  assert.equal(FS.read("/model/old.txt"), "old");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/old.txt"]);
});

test("synchronous viewer request failure rolls back the new model before dropping backup", async () => {
  const FS = createMemoryFs();
  FS.seed("/model/old.txt", "old");
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "ccall-failure",
      entries: [{ relativePath: "new.bin" }],
      readBytes: async () => new TextEncoder().encode("new").buffer,
      onCommit: () => { throw new Error("injected ccall failure"); }
    }),
    /injected ccall failure/
  );
  assert.equal(FS.read("/model/old.txt"), "old");
  assert.deepEqual(FS.paths(), ["/", "/model", "/model/old.txt"]);
});

test("failed rollback reports and retains the old viewer backup", async () => {
  let renameAttempts = 0;
  const FS = createMemoryFs({ failRename: (_from, to) => to === "/model" && ++renameAttempts === 2 });
  FS.seed("/model/old.txt", "old");
  await assert.rejects(
    replaceViewerModel({
      FS,
      token: "ccall-rollback-failure",
      entries: [{ relativePath: "new.bin" }],
      readBytes: async () => new TextEncoder().encode("new").buffer,
      onCommit: () => { throw new Error("injected ccall failure"); }
    }),
    /old viewer backup retained at \/model\.\__purism_backup_ccall-rollback-failure/
  );
  assert.equal(FS.read("/model.__purism_backup_ccall-rollback-failure/old.txt"), "old");
  assert.deepEqual(FS.paths(), [
    "/",
    "/model.__purism_backup_ccall-rollback-failure",
    "/model.__purism_backup_ccall-rollback-failure/old.txt"
  ]);
});

for (const [operation, options] of [
  ["unlink", { failUnlink: (path) => path === "/model/new.bin" }],
  ["rmdir", { failRmdir: (path) => path === "/model" }]
]) {
  test(`failed rollback ${operation} retains backup and reports cleanup failure`, async () => {
    const token = `ccall-${operation}-failure`;
    const FS = createMemoryFs(options);
    FS.seed("/model/old.txt", "old");
    await assert.rejects(
      replaceViewerModel({
        FS,
        token,
        entries: [{ relativePath: "new.bin" }],
        readBytes: async () => new TextEncoder().encode("new").buffer,
        onCommit: () => { throw new Error("injected ccall failure"); }
      }),
      new RegExp(`injected ${operation} failure.*old viewer backup retained`)
    );
    assert.equal(FS.read(`/model.__purism_backup_${token}/old.txt`), "old");
  });
}

test("client race: reload during an old load lets the new viewer reach ready without stale error", async () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const element = (id) => {
    const value = {
      id,
      disabled: false,
      value: "",
      files: [],
      textContent: "",
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      dispatch(type) { return this.listeners.get(type)?.({ target: this }); },
      click() {}
    };
    elements.set(id, value);
    return value;
  };
  for (const id of ["directory", "files", "choose-directory", "choose-files", "load-files", "clear-files", "pending", "status", "viewer"]) element(id);
  const frame = elements.get("viewer");
  frame.listeners = new Map();
  frame.addEventListener = function addEventListener(type, listener) { this.listeners.set(type, listener); };
  frame.dispatchLoad = function dispatchLoad() { this.listeners.get("load")?.(); };

  const makeDocument = (readyState) => ({ readyState, defaultView: null, getElementById: () => null });
  const firstDocument = makeDocument("loading");
  const firstFS = createMemoryFs();
  firstFS.initialized = true;
  const firstWindow = { Module: { calledRun: true, FS: firstFS, ccall() {} } };
  firstDocument.defaultView = firstWindow;
  frame.contentDocument = firstDocument;
  frame.contentWindow = firstWindow;
  globalThis.document = { getElementById: (id) => elements.get(id) };

  let releaseRead;
  let readStarted;
  const readStartedPromise = new Promise((resolve) => { readStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const modelJson = JSON.stringify({ FileReferences: { Moc: "model.moc3", Textures: ["texture.png"] } });
  const modelFile = fileLike("model.model3.json", modelJson, "root/model.model3.json");
  const modelBytes = new TextEncoder().encode(modelJson);
  modelFile.arrayBuffer = async () => {
    readStarted();
    await readGate;
    return modelBytes.slice().buffer;
  };
  const files = [modelFile, fileLike("model.moc3", "moc", "root/model.moc3"), fileLike("texture.png", "png", "root/texture.png")];
  let releaseSecondRead;
  let secondReadStarted;
  const secondReadStartedPromise = new Promise((resolve) => { secondReadStarted = resolve; });
  const secondReadGate = new Promise((resolve) => { releaseSecondRead = resolve; });
  const secondModelFile = fileLike("model.model3.json", modelJson, "root/model.model3.json");
  secondModelFile.arrayBuffer = async () => {
    secondReadStarted();
    await secondReadGate;
    return modelBytes.slice().buffer;
  };
  const secondFiles = [secondModelFile, fileLike("model.moc3", "moc-2", "root/model.moc3"), fileLike("texture.png", "png-2", "root/texture.png")];

  try {
    await import(`../scripts/purism-preview/client.mjs?synthetic-race=${Date.now()}-${Math.random()}`);
    frame.dispatchLoad();
    const directory = elements.get("directory");
    directory.value = "old-selection";
    directory.files = files;
    directory.dispatch("change");
    await readStartedPromise;

    const secondDocument = makeDocument("complete");
    const secondFS = createMemoryFs();
    secondFS.initialized = true;
    const secondWindow = { Module: { calledRun: true, FS: secondFS, ccall() {} } };
    secondDocument.defaultView = secondWindow;
    frame.contentDocument = secondDocument;
    frame.contentWindow = secondWindow;
    frame.dispatchLoad();

    // The reload cancels the old ownership, so the same directory can be
    // selected again. Keep the replacement load pending while the old
    // operation settles; its finally must not clear this newer value.
    assert.equal(directory.value, "");
    directory.value = "new-selection";
    directory.files = secondFiles;
    directory.dispatch("change");
    await secondReadStartedPromise;
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(directory.value, "new-selection");
    releaseSecondRead();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.match(elements.get("status").textContent, /^已驗證並送入本機 viewer/);
    assert.equal(elements.get("choose-directory").disabled, false);
    assert.equal(elements.get("choose-files").disabled, false);
    assert.equal(directory.value, "");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("client operation generation blocks delayed model text from loading into a new iframe", async () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const element = (id) => {
    const value = {
      id, disabled: false, value: "", files: [], textContent: "", listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      dispatch(type) { return this.listeners.get(type)?.({ target: this }); },
      click() {}
    };
    elements.set(id, value);
    return value;
  };
  for (const id of ["directory", "files", "choose-directory", "choose-files", "load-files", "clear-files", "pending", "status", "viewer"]) element(id);
  const frame = elements.get("viewer");
  frame.addEventListener = function addEventListener(type, listener) { this.listeners.set(type, listener); };
  frame.dispatchLoad = function dispatchLoad() { this.listeners.get("load")?.(); };
  const makeDocument = (readyState) => ({ readyState, defaultView: null, getElementById: () => null });
  const firstDocument = makeDocument("loading");
  const firstFS = createMemoryFs();
  firstFS.initialized = true;
  let firstRequests = 0;
  const firstWindow = { Module: { calledRun: true, FS: firstFS, ccall() { firstRequests += 1; } } };
  firstDocument.defaultView = firstWindow;
  frame.contentDocument = firstDocument;
  frame.contentWindow = firstWindow;
  globalThis.document = { getElementById: (id) => elements.get(id) };

  let releaseText;
  let textStarted;
  const textStartedPromise = new Promise((resolve) => { textStarted = resolve; });
  const textGate = new Promise((resolve) => { releaseText = resolve; });
  const modelJson = JSON.stringify({ FileReferences: { Moc: "model.moc3", Textures: ["texture.png"] } });
  const oldModel = fileLike("model.model3.json", modelJson, "root/model.model3.json");
  oldModel.text = async () => {
    textStarted();
    await textGate;
    return modelJson;
  };
  const oldFiles = [oldModel, fileLike("model.moc3", "old-moc", "root/model.moc3"), fileLike("texture.png", "old-texture", "root/texture.png")];
  let releaseSecondRead;
  let secondReadStarted;
  const secondReadStartedPromise = new Promise((resolve) => { secondReadStarted = resolve; });
  const secondReadGate = new Promise((resolve) => { releaseSecondRead = resolve; });
  const newModel = fileLike("model.model3.json", modelJson, "root/model.model3.json");
  newModel.arrayBuffer = async () => {
    secondReadStarted();
    await secondReadGate;
    return new TextEncoder().encode(modelJson).buffer;
  };
  const newFiles = [newModel, fileLike("model.moc3", "new-moc", "root/model.moc3"), fileLike("texture.png", "new-texture", "root/texture.png")];
  const secondDocument = makeDocument("complete");
  const secondFS = createMemoryFs();
  secondFS.initialized = true;
  let secondRequests = 0;
  const secondWindow = { Module: { calledRun: true, FS: secondFS, ccall() { secondRequests += 1; } } };
  secondDocument.defaultView = secondWindow;

  try {
    await import(`../scripts/purism-preview/client.mjs?synthetic-text-race=${Date.now()}-${Math.random()}`);
    frame.dispatchLoad();
    const directory = elements.get("directory");
    directory.value = "old-selection";
    directory.files = oldFiles;
    directory.dispatch("change");
    await textStartedPromise;

    frame.contentDocument = secondDocument;
    frame.contentWindow = secondWindow;
    frame.dispatchLoad();
    assert.equal(directory.value, "");
    directory.value = "new-selection";
    directory.files = newFiles;
    directory.dispatch("change");
    await secondReadStartedPromise;

    releaseText();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(firstRequests, 0);
    assert.equal(secondRequests, 0);
    assert.equal(directory.value, "new-selection");

    releaseSecondRead();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(firstRequests, 0);
    assert.equal(secondRequests, 1);
    assert.match(elements.get("status").textContent, /^已驗證並送入本機 viewer/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
