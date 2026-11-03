import {
  mergeMultiFileSelection,
  prepareDirectoryEntries,
  prepareMultiFileEntries,
  selectReferencedEntries
} from "./import-policy.mjs";
import {
  canCommitViewerStatus,
  isCurrentViewerContext,
  replaceViewerModel,
  shouldHandleFrameLoad,
  transitionAfterViewerReload
} from "./client-state.mjs";

const directoryInput = document.getElementById("directory");
const filesInput = document.getElementById("files");
const chooseDirectory = document.getElementById("choose-directory");
const chooseFiles = document.getElementById("choose-files");
const loadFiles = document.getElementById("load-files");
const clearFiles = document.getElementById("clear-files");
const pendingLabel = document.getElementById("pending");
const status = document.getElementById("status");
const frame = document.getElementById("viewer");
let pendingMultiFiles = Object.freeze([]);
let loadInFlight = false;
let viewerReady;
let viewerGeneration = 0;
let statusState = "booting";
let generation = 0;
let handledFrameDocument;
let activeSourceInput;
let activeSourceFiles;

function setStatus(message, expectedGeneration = generation) {
  if (expectedGeneration === generation) status.textContent = message;
}

function assertCurrentLoadOperation(expectedGeneration) {
  if (expectedGeneration !== generation) throw new Error("目前模型載入已取消");
}

function refreshPending() {
  const count = pendingMultiFiles.length;
  pendingLabel.textContent = count ? `已累積 ${count} 個檔案：${pendingMultiFiles.map((file) => file.name).join("、")}` : "尚未累積 fallback 檔案";
  loadFiles.disabled = loadInFlight || count === 0;
  clearFiles.disabled = loadInFlight || count === 0;
}

function safeFetchGuard(win) {
  if (win.__purismPreviewFetchGuard || typeof win.fetch !== "function") return;
  const originalFetch = win.fetch.bind(win);
  win.fetch = (resource, options) => {
    const raw = resource instanceof win.Request ? resource.url : resource;
    const url = new URL(raw, win.location.href);
    if (url.origin !== win.location.origin) return Promise.reject(new Error("blocked cross-origin viewer fetch"));
    return originalFetch(resource, options);
  };
  win.__purismPreviewFetchGuard = true;
}

function disableUpstreamFileUi(doc) {
  const file = doc.getElementById("file");
  const load = doc.getElementById("load");
  if (file) { file.disabled = true; file.hidden = true; }
  if (load) { load.disabled = true; load.hidden = true; }
  const canvas = doc.getElementById("canvas");
  const glfw = doc.defaultView?.GLFW;
  if (!canvas || !glfw?.onDrop || canvas.__purismPreviewDropGuarded) return;
  canvas.removeEventListener("drop", glfw.onDrop, true);
  canvas.removeEventListener("dragover", glfw.onDragover, true);
  canvas.removeEventListener("dragenter", glfw.onDragenter, true);
  const block = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  canvas.addEventListener("drop", block, true);
  canvas.addEventListener("dragover", block, true);
  canvas.addEventListener("dragenter", block, true);
  canvas.__purismPreviewDropGuarded = true;
}

function waitForViewer() {
  const expectedViewerGeneration = viewerGeneration;
  if (viewerReady?.generation === expectedViewerGeneration) return viewerReady.promise;
  const pending = new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      try {
        if (expectedViewerGeneration !== viewerGeneration) return reject(new Error("viewer 已重新載入，請重試"));
        const win = frame.contentWindow;
        safeFetchGuard(win);
        disableUpstreamFileUi(frame.contentDocument);
        if (win.Module?.calledRun && win.Module?.FS?.initialized === true && typeof win.Module.ccall === "function") return resolve(win);
      } catch (error) { return reject(error); }
      if (Date.now() >= deadline) return reject(new Error("viewer runtime timeout"));
      setTimeout(poll, 50);
    };
    poll();
  });
  viewerReady = { generation: expectedViewerGeneration, promise: pending };
  pending.catch(() => { if (viewerReady?.promise === pending) viewerReady = undefined; });
  return pending;
}

async function readModelJson(manifest, expectedGeneration) {
  assertCurrentLoadOperation(expectedGeneration);
  const entry = manifest.entries.find((candidate) => candidate.relativePath === manifest.modelPath);
  if (!entry || !manifest.modelPath.toLowerCase().endsWith(".model3.json")) return manifest;
  try {
    const text = await entry.file.text();
    assertCurrentLoadOperation(expectedGeneration);
    const selected = selectReferencedEntries(manifest, JSON.parse(text));
    assertCurrentLoadOperation(expectedGeneration);
    return selected;
  }
  catch (error) { throw new Error(error.message || "model3 JSON 無法解析"); }
}

async function sendToViewer(manifest, expectedGeneration) {
  assertCurrentLoadOperation(expectedGeneration);
  const win = await waitForViewer();
  assertCurrentLoadOperation(expectedGeneration);
  const expectedViewerContext = {
    viewerGeneration,
    document: frame.contentDocument,
    window: win
  };
  const assertCurrentViewer = () => {
    assertCurrentLoadOperation(expectedGeneration);
    if (!isCurrentViewerContext({ viewerGeneration, document: frame.contentDocument, window: frame.contentWindow }, expectedViewerContext)) {
      throw new Error("viewer 已重新載入，目前模型載入已取消");
    }
  };
  assertCurrentViewer();
  const root = "/model";
  const replacement = await replaceViewerModel({
    FS: win.Module.FS,
    entries: manifest.entries,
    root,
    token: `${viewerGeneration}_${generation}_${Date.now()}`,
    readBytes: (entry) => entry.file.arrayBuffer(),
    assertCurrent: assertCurrentViewer,
    onCommit: () => win.Module.ccall("ViewerRequestLoad", null, ["string"], [`${root}/${manifest.modelPath}`])
  });
  // The MEMFS swap and synchronous request hand-off are transactional; the
  // viewer's later parse/render work is asynchronous and owned by the pinned
  // runtime, so a later failure cannot be rolled back by this wrapper.
  assertCurrentViewer();
  const ignored = manifest.ignoredPaths?.length ? `；忽略 ${manifest.ignoredPaths.length} 個無關檔案` : "";
  const cleanupWarning = replacement.oldModelCleanupError ? "；舊 viewer 暫存清理失敗，仍保留以避免資料遺失" : "";
  return `已驗證並送入本機 viewer：${manifest.entries.length} files、${manifest.totalBytes} bytes${ignored}${cleanupWarning}；load request 非同步，未將此訊息當作畫面驗收`;
}

async function loadSelection(fileList, multiFile, expectedGeneration) {
  assertCurrentLoadOperation(expectedGeneration);
  let manifest = multiFile ? await prepareMultiFileEntries(fileList) : prepareDirectoryEntries(fileList);
  assertCurrentLoadOperation(expectedGeneration);
  manifest = await readModelJson(manifest, expectedGeneration);
  assertCurrentLoadOperation(expectedGeneration);
  const message = await sendToViewer(manifest, expectedGeneration);
  setStatus(message, expectedGeneration);
  return message;
}

function beginLoad(fileList, multiFile, sourceInput = null) {
  const currentGeneration = ++generation;
  if (sourceInput) {
    activeSourceInput = sourceInput;
    activeSourceFiles = fileList;
  }
  loadInFlight = true;
  statusState = "loading";
  chooseDirectory.disabled = true;
  chooseFiles.disabled = true;
  loadFiles.disabled = true;
  clearFiles.disabled = true;
  setStatus("正在驗證本機參照並送入 viewer…", currentGeneration);
  loadSelection(fileList, multiFile, currentGeneration)
    .then((message) => {
      if (currentGeneration !== generation) return;
      statusState = "request-submitted";
      setStatus(message, currentGeneration);
    })
    .catch((error) => {
      if (currentGeneration !== generation) return;
      statusState = "error";
      setStatus(error.message, currentGeneration);
    })
    .finally(() => {
      if (currentGeneration === generation) {
        loadInFlight = false;
        chooseDirectory.disabled = false;
        chooseFiles.disabled = false;
        refreshPending();
      }
      if (sourceInput && currentGeneration === generation
        && sourceInput === activeSourceInput && sourceInput.files === activeSourceFiles) {
        sourceInput.value = "";
        activeSourceInput = undefined;
        activeSourceFiles = undefined;
      }
    });
}

chooseDirectory.addEventListener("click", () => directoryInput.click());
chooseFiles.addEventListener("click", () => filesInput.click());
directoryInput.addEventListener("change", () => beginLoad(directoryInput.files, false, directoryInput));
filesInput.addEventListener("change", () => {
  try {
    pendingMultiFiles = mergeMultiFileSelection(pendingMultiFiles, filesInput.files);
    refreshPending();
    setStatus("已加入本批檔案；可繼續選取，或按載入已選檔案");
  } catch (error) { setStatus(error.message); }
  finally { filesInput.value = ""; }
});
loadFiles.addEventListener("click", () => { if (!loadInFlight) beginLoad(pendingMultiFiles, true); });
clearFiles.addEventListener("click", () => {
  if (loadInFlight) return;
  pendingMultiFiles = Object.freeze([]);
  refreshPending();
  setStatus("已清空 fallback 檔案");
});
function handleFrameLoad() {
  const currentDocument = frame.contentDocument;
  if (!shouldHandleFrameLoad(handledFrameDocument, currentDocument)) return;
  const hadPreviousDocument = handledFrameDocument != null;
  handledFrameDocument = currentDocument;
  viewerGeneration += 1;
  viewerReady = undefined;
  const frameState = transitionAfterViewerReload(
    { statusState, loadInFlight, generation },
    { hasPreviousDocument: hadPreviousDocument }
  );
  statusState = frameState.statusState;
  loadInFlight = frameState.loadInFlight;
  generation = frameState.generation;
  if (hadPreviousDocument) {
    if (activeSourceInput && activeSourceInput.files === activeSourceFiles) {
      // Clear only the selection owned by the cancelled load. If a newer load
      // already owns this input, its files/value must remain untouched.
      activeSourceInput.value = "";
      activeSourceInput = undefined;
      activeSourceFiles = undefined;
    }
    chooseDirectory.disabled = false;
    chooseFiles.disabled = false;
    refreshPending();
    setStatus("viewer 重新初始化…");
  }
  const frameLoadGeneration = generation;
  const expectedViewerGeneration = viewerGeneration;
  waitForViewer().then(() => {
    if (!canCommitViewerStatus({ viewerGeneration, generation, loadInFlight, statusState }, { viewerGeneration: expectedViewerGeneration, generation: frameLoadGeneration })) return;
    setStatus("viewer ready；請選擇本機模型目錄", frameLoadGeneration);
  }).catch((error) => {
    if (!canCommitViewerStatus({ viewerGeneration, generation, loadInFlight, statusState }, { viewerGeneration: expectedViewerGeneration, generation: frameLoadGeneration })) return;
    statusState = "error";
    setStatus(error.message, frameLoadGeneration);
  });
}

frame.addEventListener("load", handleFrameLoad);
// The module script is deferred and can miss an iframe load that already
// completed. Handle the current document immediately, while the listener above
// continues to cover later reloads.
if (frame.contentDocument?.readyState !== "loading") handleFrameLoad();
refreshPending();
