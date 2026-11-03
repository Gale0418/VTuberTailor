/**
 * Guards for asynchronous iframe readiness/status commits and viewer MEMFS
 * replacement. A stale frame promise must never overwrite a newer frame or
 * load result.
 */
export function canCommitViewerStatus(current, candidate) {
  return current?.statusState === "booting" && current.loadInFlight === false
    && candidate?.viewerGeneration === current.viewerGeneration
    && candidate.generation === current.generation;
}

export function shouldHandleFrameLoad(lastDocument, currentDocument) {
  return currentDocument != null && currentDocument !== lastDocument;
}

export function transitionAfterFrameLoad(current, { hasPreviousDocument = false } = {}) {
  if (!hasPreviousDocument) return Object.freeze({ ...current });
  return Object.freeze({
    ...current,
    statusState: current.loadInFlight ? "loading" : "booting"
  });
}

/**
 * A frame reload cancels any load tied to the detached document. Advance the
 * load generation so its catch/finally handlers cannot mutate the new frame's
 * state, and let the new viewer boot independently.
 */
export function transitionAfterViewerReload(current, { hasPreviousDocument = false } = {}) {
  if (!hasPreviousDocument) return Object.freeze({ ...current });
  return Object.freeze({
    ...current,
    generation: (current.generation ?? 0) + 1,
    loadInFlight: false,
    statusState: "booting"
  });
}

export function isCurrentViewerContext(current, expected) {
  return current?.viewerGeneration === expected?.viewerGeneration
    && current.document === expected.document
    && current.window === expected.window;
}

function mkdirp(FS, path) {
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current += `/${segment}`;
    try { FS.mkdir(current); }
    catch (error) {
      let info;
      try { info = FS.stat(current); } catch { throw error; }
      if (!FS.isDir(info.mode)) throw error;
    }
  }
}

function rmrf(FS, path) {
  let info;
  try { info = FS.stat(path); } catch { return; }
  if (FS.isDir(info.mode)) {
    for (const name of FS.readdir(path)) if (name !== "." && name !== "..") rmrf(FS, `${path}/${name}`);
    FS.rmdir(path);
  } else FS.unlink(path);
}

function exists(FS, path) {
  try { FS.stat(path); return true; } catch { return false; }
}

function errorWithCleanup(error, cleanupErrors, { backupRoot, backupRetained = false } = {}) {
  if (cleanupErrors.length === 0 && !backupRetained) return error;
  const details = cleanupErrors.map((item) => item instanceof Error ? item.message : String(item)).join(" | ");
  const cleanupDetail = details ? `; viewer transaction cleanup failed: ${details}` : "";
  const backupDetail = backupRetained ? `; old viewer backup retained at ${backupRoot}` : "";
  const wrapped = new Error(`${error instanceof Error ? error.message : String(error)}${cleanupDetail}${backupDetail}`);
  wrapped.cause = error;
  return wrapped;
}

/**
 * Write a model into a private MEMFS staging directory and swap it into place
 * only after every byte has been read and written.  The callback is checked
 * around every asynchronous read and before the synchronous directory swap so
 * an iframe reload cannot commit a detached viewer context. Files are read one
 * at a time; the policy's 256 MiB manifest cap remains the upper bound for the
 * staged model, while the old model is retained in that context until the
 * short swap window. `onCommit` must be synchronous; a replacement iframe
 * starts with its own empty MEMFS.
 */
export async function replaceViewerModel({ FS, entries, root = "/model", token, readBytes, assertCurrent = () => {}, onCommit = () => {} }) {
  if (!FS || !Array.isArray(entries) || typeof readBytes !== "function") throw new TypeError("replaceViewerModel 參數無效");
  if (typeof onCommit !== "function") throw new TypeError("replaceViewerModel onCommit 必須是函式");
  const suffix = String(token ?? "transaction").replace(/[^A-Za-z0-9_-]/g, "_");
  const stagingRoot = `${root}.__purism_pending_${suffix}`;
  const backupRoot = `${root}.__purism_backup_${suffix}`;
  if (exists(FS, stagingRoot) || exists(FS, backupRoot)) throw new Error("viewer 暫存交易名稱已存在");

  let stagingCreated = false;
  try {
    mkdirp(FS, stagingRoot);
    stagingCreated = true;
    for (const entry of entries) {
      assertCurrent();
      const target = `${stagingRoot}/${entry.relativePath}`;
      const slash = target.lastIndexOf("/");
      if (slash > 0) mkdirp(FS, target.slice(0, slash));
      const bytes = await readBytes(entry);
      assertCurrent();
      FS.writeFile(target, new Uint8Array(bytes));
    }
    assertCurrent();

    const hadOldModel = exists(FS, root);
    let oldModelMoved = false;
    let newModelInstalled = false;
    try {
      if (hadOldModel) {
        FS.rename(root, backupRoot);
        oldModelMoved = true;
      }
      FS.rename(stagingRoot, root);
      stagingCreated = false;
      newModelInstalled = true;
      // This callback is deliberately synchronous.  It covers the request
      // hand-off itself while backupRoot still exists, so a ccall failure can
      // restore the old model before the backup is discarded.
      onCommit();
    } catch (error) {
      const rollbackErrors = [];
      if (newModelInstalled && exists(FS, root)) {
        try { rmrf(FS, root); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (oldModelMoved && !exists(FS, root) && exists(FS, backupRoot)) {
        try { FS.rename(backupRoot, root); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (stagingCreated) {
        try { rmrf(FS, stagingRoot); }
        catch (cleanupError) { rollbackErrors.push(cleanupError); }
      }
      throw errorWithCleanup(error, rollbackErrors, {
        backupRoot,
        backupRetained: oldModelMoved && exists(FS, backupRoot)
      });
    }

    let oldModelCleanupError = null;
    if (oldModelMoved) {
      try { rmrf(FS, backupRoot); }
      catch (error) { oldModelCleanupError = error; }
    }
    return Object.freeze({ oldModelCleanupError });
  } catch (error) {
    if (stagingCreated && exists(FS, stagingRoot)) {
      try { rmrf(FS, stagingRoot); }
      catch (cleanupError) { throw errorWithCleanup(error, [cleanupError]); }
    }
    throw error;
  }
}
