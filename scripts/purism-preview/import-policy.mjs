/**
 * Browser-safe policy for local model3/moc3 selection.
 *
 * This module deliberately does not read model/texture bytes except for the
 * model3 JSON needed to resolve FileReferences. It never handles ZIP files.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxFiles: 256,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024
});

export const SUPPORTED_SUFFIXES = Object.freeze([
  ".model3.json", ".moc3", ".png", ".jpg", ".jpeg",
  ".cdi3.json", ".physics3.json", ".userdata3.json", ".motion3.json",
  ".exp3.json", ".pose3.json", ".vtube.json", ".prprl2d.json", ".live.json"
]);

function fail(message) {
  throw new Error(`[purism-preview] ${message}`);
}

export function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024)
    fail("relativePath 為空或過長");
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0"))
    fail("禁止絕對路徑或 NUL");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    fail("禁止空 path segment、. 或 .. traversal");
  return parts.join("/");
}

function isSupportedAsset(path) {
  const lower = path.toLowerCase();
  return !lower.endsWith(".zip") && SUPPORTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function stripPrefix(path, prefix) {
  if (!prefix) return path;
  const expected = `${prefix}/`;
  return path.startsWith(expected) ? path.slice(expected.length) : null;
}

function checkFileSize(file, path, limits) {
  const size = Number(file?.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes)
    fail(`單檔超過限制或 size 非法：${path}`);
  return size;
}

export function prepareDirectoryEntries(fileList, limits = IMPORT_LIMITS) {
  if (!fileList || typeof fileList[Symbol.iterator] !== "function")
    fail("需要 webkitdirectory FileList");
  const normalized = [];
  const seenInput = new Set();
  for (const file of fileList) {
    const raw = file?.webkitRelativePath || file?.relativePath || file?.name;
    const path = normalizeRelativePath(raw);
    const key = path.toLocaleLowerCase("en-US");
    if (seenInput.has(key)) fail(`重複 relativePath：${path}`);
    seenInput.add(key);
    normalized.push({ file, path, size: checkFileSize(file, path, limits) });
  }
  if (normalized.length === 0) fail("目錄沒有檔案");
  if (normalized.length > limits.maxFiles) fail(`目錄輸入檔案數超過 ${limits.maxFiles}`);
  const inputTotalBytes = normalized.reduce((sum, entry) => sum + entry.size, 0);
  if (inputTotalBytes > limits.maxTotalBytes) fail(`目錄輸入總大小超過 ${limits.maxTotalBytes} bytes`);

  const model3s = normalized.filter((entry) => entry.path.toLowerCase().endsWith(".model3.json"));
  const moc3s = normalized.filter((entry) => entry.path.toLowerCase().endsWith(".moc3"));
  if (model3s.length > 1 || (model3s.length === 0 && moc3s.length !== 1))
    fail(`需要一個 model3.json，或沒有 model3 時恰好一個 moc3；model3=${model3s.length} moc3=${moc3s.length}`);
  const modelEntry = model3s[0] ?? moc3s[0];
  const modelRoot = dirname(modelEntry.path);
  const entries = [];
  const ignoredPaths = [];
  const seenRoot = new Set();
  for (const entry of normalized) {
    const relativePath = stripPrefix(entry.path, modelRoot);
    if (relativePath === null) continue;
    if (!isSupportedAsset(relativePath)) {
      ignoredPaths.push(relativePath);
      continue;
    }
    const key = relativePath.toLocaleLowerCase("en-US");
    if (seenRoot.has(key)) fail(`模型根目錄內重複路徑：${relativePath}`);
    seenRoot.add(key);
    entries.push({ ...entry, relativePath });
  }
  if (entries.length > limits.maxFiles) fail(`檔案數超過 ${limits.maxFiles}`);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > limits.maxTotalBytes) fail(`總大小超過 ${limits.maxTotalBytes} bytes`);
  const modelPath = modelEntry.path.slice(modelRoot ? modelRoot.length + 1 : 0);
  if (!entries.some((entry) => entry.relativePath === modelPath)) fail("model3/moc3 不在模型根目錄");
  return Object.freeze({ modelRoot, modelPath, entries: Object.freeze(entries), ignoredPaths: Object.freeze(ignoredPaths), totalBytes });
}

const DIRECT_REFERENCE_KEYS = new Set(["Moc", "Textures", "Physics", "Pose", "DisplayInfo", "UserData"]);

function collectReferenceStrings(value, key, references) {
  if (typeof value === "string") {
    // Optional model3 references are commonly serialized as an empty string
    // when the asset is not supplied.  Keep the mandatory Moc/Textures checks
    // below strict, but do not turn absent optional assets into a path error.
    if (value !== "" && (key === "File" || DIRECT_REFERENCE_KEYS.has(key))) references.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceStrings(item, key, references);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) collectReferenceStrings(childValue, childKey, references);
}

export function model3ReferencedPaths(modelJson) {
  if (!modelJson || typeof modelJson !== "object" || Array.isArray(modelJson)) fail("model3 必須是 JSON object");
  const fileReferences = modelJson.FileReferences;
  if (!fileReferences || typeof fileReferences !== "object" || Array.isArray(fileReferences)) fail("model3 缺少 FileReferences");
  if (typeof fileReferences.Moc !== "string" || fileReferences.Moc.trim() === "") fail("FileReferences.Moc 必須是非空字串");
  if (!Array.isArray(fileReferences.Textures) || fileReferences.Textures.length === 0 || fileReferences.Textures.some((path) => typeof path !== "string" || path.trim() === ""))
    fail("FileReferences.Textures 必須是非空字串陣列");
  const references = new Set();
  collectReferenceStrings(fileReferences, "FileReferences", references);
  return Object.freeze([...references].map((path) => normalizeRelativePath(path)));
}

export function selectReferencedEntries(manifest, modelJson) {
  if (!manifest || !Array.isArray(manifest.entries)) fail("無效 directory manifest");
  const references = new Set([manifest.modelPath]);
  for (const path of model3ReferencedPaths(modelJson)) references.add(path);
  const byPath = new Map(manifest.entries.map((entry) => [entry.relativePath, entry]));
  const selected = [];
  for (const path of references) {
    const entry = byPath.get(path);
    if (!entry) fail(`model3 referenced file 缺失或大小寫不符：${path}`);
    selected.push(entry);
  }
  const totalBytes = selected.reduce((sum, entry) => sum + entry.size, 0);
  return Object.freeze({ ...manifest, entries: Object.freeze(selected), totalBytes, referencedPaths: Object.freeze(selected.map((entry) => entry.relativePath)) });
}

function normalizeFlatFile(file, limits) {
  const path = normalizeRelativePath(file?.name);
  if (path.includes("/")) fail(`multiple selection 只接受檔名：${path}`);
  return { file, path, size: checkFileSize(file, path, limits) };
}

export function mergeMultiFileSelection(currentFiles, incomingFiles, limits = IMPORT_LIMITS) {
  if (!currentFiles || typeof currentFiles[Symbol.iterator] !== "function" || !incomingFiles || typeof incomingFiles[Symbol.iterator] !== "function") fail("需要 multiple FileList");
  const normalized = [];
  const seen = new Set();
  for (const file of [...currentFiles, ...incomingFiles]) {
    const entry = normalizeFlatFile(file, limits);
    const key = entry.path.toLocaleLowerCase("en-US");
    if (seen.has(key)) fail(`選取檔案 basename 重複：${entry.path}`);
    seen.add(key);
    normalized.push(entry);
  }
  if (normalized.length > limits.maxFiles) fail(`檔案數超過 ${limits.maxFiles}`);
  const totalBytes = normalized.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > limits.maxTotalBytes) fail(`總大小超過 ${limits.maxTotalBytes} bytes`);
  return Object.freeze(normalized.map((entry) => entry.file));
}

async function readEntryText(file) {
  if (typeof file?.text === "function") return file.text();
  if (typeof file?.arrayBuffer === "function") return new TextDecoder().decode(await file.arrayBuffer());
  fail("選取檔案無法讀取");
}

export async function prepareMultiFileEntries(fileList, limits = IMPORT_LIMITS) {
  const selectedFiles = mergeMultiFileSelection([], fileList, limits);
  const normalized = selectedFiles.map((file) => normalizeFlatFile(file, limits));
  if (normalized.length === 0) fail("沒有選取檔案");
  const model3s = normalized.filter((entry) => entry.path.toLowerCase().endsWith(".model3.json"));
  const moc3s = normalized.filter((entry) => entry.path.toLowerCase().endsWith(".moc3"));
  if (model3s.length > 1 || (model3s.length === 0 && moc3s.length !== 1)) fail(`需要一個 model3.json，或沒有 model3 時恰好一個 moc3；model3=${model3s.length} moc3=${moc3s.length}`);
  const modelEntry = model3s[0] ?? moc3s[0];
  const ignoredPaths = normalized.filter((entry) => !isSupportedAsset(entry.path)).map((entry) => entry.path);
  if (!model3s.length) {
    const entries = normalized.filter((entry) => isSupportedAsset(entry.path)).map((entry) => ({ ...entry, relativePath: entry.path }));
    return Object.freeze({ modelRoot: "", modelPath: modelEntry.path, entries: Object.freeze(entries), ignoredPaths: Object.freeze(ignoredPaths), totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0) });
  }
  let modelJson;
  try { modelJson = JSON.parse(await readEntryText(modelEntry.file)); } catch { fail("model3 JSON 無法解析"); }
  const references = model3ReferencedPaths(modelJson);
  const expected = new Set([modelEntry.path, ...references]);
  const expectedBasenames = new Map();
  for (const path of expected) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const key = basename.toLocaleLowerCase("en-US");
    if (expectedBasenames.has(key) && expectedBasenames.get(key) !== path) fail(`model3 references basename 不唯一：${basename}`);
    expectedBasenames.set(key, path);
  }
  const byLowerName = new Map(normalized.map((entry) => [entry.path.toLocaleLowerCase("en-US"), entry]));
  const entries = [];
  for (const path of expected) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const entry = byLowerName.get(basename.toLocaleLowerCase("en-US"));
    if (!entry || entry.path !== basename) fail(`model3 referenced basename 缺失或大小寫不符：${path}`);
    entries.push({ ...entry, relativePath: path });
  }
  return selectReferencedEntries({ modelRoot: "", modelPath: modelEntry.path, entries, ignoredPaths, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0) }, modelJson);
}

export function rejectUnsafeQuery(search) {
  const params = new URLSearchParams(search || "");
  for (const key of params.keys()) if (key !== "selftest") fail("只允許固定 selftest query");
  if (params.has("selftest") && (params.getAll("selftest").length !== 1 || params.get("selftest") !== "1")) fail("selftest query 必須是單一 1");
  return !params.has("selftest");
}
