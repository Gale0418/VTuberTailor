import { cp, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { createProject, listCalibrationSessions, saveCalibrationPatch, verifyProject } from "../src/index.js";

const sourceProject = artifactPath(`verify-evidence-path-${process.pid}-${Date.now()}`);

async function copyProject(label: string): Promise<string> {
  const output = artifactPath(`verify-evidence-path-${label}-${process.pid}-${Date.now()}`);
  await cp(sourceProject, output, { recursive: true });
  return output;
}

async function sessionPath(project: string): Promise<string> {
  const files = await readdir(resolve(project, "calibration", "sessions"));
  expect(files).toHaveLength(1);
  return resolve(project, "calibration", "sessions", files[0]!);
}

async function setEvidenceDirectory(project: string, evidenceDirectory: string): Promise<void> {
  const sessionFile = await sessionPath(project);
  const session = JSON.parse(await readFile(sessionFile, "utf8")) as { evidenceDirectory?: string };
  session.evidenceDirectory = evidenceDirectory;
  await writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

describe("project verification evidence paths", () => {
  beforeAll(async () => {
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: sourceProject, seed: 42 });
    await saveCalibrationPatch(sourceProject, {
      baseRevision: 0,
      label: "合成證據路徑",
      overrides: { runtime: { motionTuning: { response: 0.7 } } }
    });
  }, 120_000);

  it("accepts persisted Windows-relative and POSIX evidence directories", async () => {
    const windowsProject = await copyProject("windows-relative");
    const sessions = await listCalibrationSessions(windowsProject);
    const windowsPath = sessions[0]!.evidenceDirectory!.replaceAll("/", "\\");
    await setEvidenceDirectory(windowsProject, windowsPath);
    expect((await verifyProject(windowsProject)).valid).toBe(true);

    const posixProject = await copyProject("posix-relative");
    expect((await verifyProject(posixProject)).valid).toBe(true);
  }, 120_000);

  it("uses realpath boundaries for a symlinked root and an outside evidence junction", async () => {
    const rootProject = await copyProject("root-symlink");
    const rootHolder = await mkdtemp(join(tmpdir(), "vtuber-verify-root-link-"));
    const rootAlias = join(rootHolder, "project");
    const outsideHolder = await mkdtemp(join(tmpdir(), "vtuber-verify-outside-"));
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(rootProject, rootAlias, linkType);
      expect((await verifyProject(rootAlias)).valid).toBe(true);

      const evidenceProject = await copyProject("evidence-junction");
      const sessions = await listCalibrationSessions(evidenceProject);
      const evidenceRoot = resolve(evidenceProject, sessions[0]!.evidenceDirectory!);
      const outsideEvidence = join(outsideHolder, "evidence");
      await cp(evidenceRoot, outsideEvidence, { recursive: true });
      await rm(evidenceRoot, { recursive: true, force: true });
      await symlink(outsideEvidence, evidenceRoot, linkType);
      const verified = await verifyProject(evidenceProject);
      expect(verified.valid).toBe(false);
      expect(verified.evidenceIssues).toEqual(expect.arrayContaining([expect.stringMatching(/证据目录无效/)]));
    } finally {
      await rm(rootHolder, { recursive: true, force: true });
      await rm(outsideHolder, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    ["posix-absolute", "/tmp/evidence"],
    ["traversal", "reports\\calibration\\..\\outside\\evidence"],
    ["drive", "C:\\Characters\\model\\reports\\calibration\\evidence"],
    ["unc", "\\\\server\\share\\reports\\calibration\\evidence"]
  ])("rejects %s evidence directories", async (_label, evidenceDirectory) => {
    const project = await copyProject(_label);
    await setEvidenceDirectory(project, evidenceDirectory);
    const verified = await verifyProject(project);
    expect(verified.valid).toBe(false);
    expect(verified.evidenceIssues).toEqual(expect.arrayContaining([expect.stringMatching(/证据目录无效/)]));
  }, 120_000);

  it("still reports missing evidence after resolving a Windows-relative directory", async () => {
    const project = await copyProject("missing");
    const sessions = await listCalibrationSessions(project);
    const evidenceDirectory = sessions[0]!.evidenceDirectory!;
    const evidenceRoot = resolve(project, evidenceDirectory);
    await setEvidenceDirectory(project, evidenceDirectory.replaceAll("/", "\\"));
    await unlink(join(evidenceRoot, "difference.png"));
    const verified = await verifyProject(project);
    expect(verified.valid).toBe(false);
    expect(verified.evidenceIssues).toEqual(expect.arrayContaining([expect.stringMatching(/difference\.png/)]));
  }, 120_000);

  it("still verifies evidence hashes after resolving a Windows-relative directory", async () => {
    const project = await copyProject("hash-mismatch");
    const sessions = await listCalibrationSessions(project);
    const evidenceDirectory = sessions[0]!.evidenceDirectory!;
    const evidenceRoot = resolve(project, evidenceDirectory);
    await setEvidenceDirectory(project, evidenceDirectory.replaceAll("/", "\\"));
    const difference = join(evidenceRoot, "difference.png");
    await writeFile(difference, Buffer.concat([await readFile(difference), Buffer.from([0])]));
    const verified = await verifyProject(project);
    expect(verified.valid).toBe(false);
    expect(verified.evidenceIssues).toEqual(expect.arrayContaining([expect.stringMatching(/difference\.png 哈希不一致/)]));
  }, 120_000);
});
