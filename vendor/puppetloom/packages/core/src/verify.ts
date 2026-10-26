import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { canonicalizeReferencePixel, rasterizeRegisteredAsset, solveAssetRegistration } from "./asset-registration.js";
import { listCalibrationSessions, loadCalibration, loadProject } from "./project.js";
import type { LayerBinding, PuppetLoomProject, VerifyResult } from "./types.js";

interface HighDensityTextureSize { width: number; height: number }

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function closePixel(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-6;
}

/** Permit larger PNGs only when an immutable public registration proves their density and frame. */
async function registeredHighDensitySize(root: string, project: PuppetLoomProject, layer: LayerBinding, texturePath: string): Promise<HighDensityTextureSize> {
  const withinProject = (path: string): boolean => {
    const relation = relative(root, path);
    return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  };
  const asset = layer.generatedAsset;
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.registrationId)) throw new Error("高密度纹理缺少有效 generatedAsset registration ID。");
  const registrationPath = join(root, "assets", "registrations", `${asset.registrationId}.json`);
  const registrationBytes = await readFile(registrationPath);
  if (sha256(registrationBytes) !== asset.registrationId) throw new Error("registration 文件內容與不可變 registration ID 不符。");
  const registration = JSON.parse(registrationBytes.toString("utf8")) as {
    referenceId?: unknown;
    originalPath?: unknown;
    originalSha256?: unknown;
    texture?: unknown;
    textureSha256?: unknown;
    bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    registration?: { matrix?: { a?: unknown; b?: unknown; c?: unknown; d?: unknown; tx?: unknown; ty?: unknown }; input?: { kind?: unknown; textureScale?: unknown; preserveFrame?: unknown; sourceRect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }; anchors?: unknown[]; maxErrorPixels?: unknown; mirrorX?: unknown; mirrorY?: unknown } };
  };
  if (registration.referenceId !== asset.referenceId) throw new Error("registration.referenceId 與 generatedAsset 不符。");
  if (registration.originalSha256 !== asset.imageSha256) throw new Error("registration 原始 PNG SHA-256 與 generatedAsset 不符。");
  if (registration.texture !== layer.texture) throw new Error("registration texture path 與圖層 texture 不符。");
  if (typeof registration.textureSha256 !== "string" || sha256(await readFile(texturePath)) !== registration.textureSha256) throw new Error("texture PNG SHA-256 與 registration 不符。");
  if (typeof registration.originalPath !== "string" || !withinProject(resolve(root, registration.originalPath)) || sha256(await readFile(resolve(root, registration.originalPath))) !== registration.originalSha256) throw new Error("原始 PNG SHA-256 與 registration 不符。");

  const referenceId = asset.referenceId;
  if (!/^[a-f0-9]{64}$/.test(referenceId)) throw new Error("generatedAsset reference ID 格式無效。");
  const referenceBytes = await readFile(join(root, "assets", "references", `${referenceId}.json`));
  if (sha256(referenceBytes) !== referenceId) throw new Error("reference 文件內容與不可變 reference ID 不符。");
  const reference = JSON.parse(referenceBytes.toString("utf8")) as { templateLayerId?: unknown; canvas?: { width?: unknown; height?: unknown }; sourceRect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
  if (reference.templateLayerId !== asset.templateLayerId) throw new Error("reference templateLayerId 與 generatedAsset 不符。");
  if (reference.canvas?.width !== project.canvas.width || reference.canvas?.height !== project.canvas.height) throw new Error("registration reference canvas 與有效模型畫布不符。");

  const input = registration.registration?.input;
  const scale = input?.textureScale;
  const registeredBounds = registration.bounds;
  if (!Number.isInteger(scale) || (scale as number) < 2 || (scale as number) > 4 || !registeredBounds) throw new Error("高密度 PNG 必須明確記錄 textureScale 2 到 4 與 world bounds。");
  if (input?.kind === "frame") {
    const frame = input.sourceRect;
    if (!frame || !reference.sourceRect) throw new Error("registration 缺少 frame/sourceRect 證據。");
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof frame[key] !== "number" || typeof reference.sourceRect[key] !== "number" || frame[key] !== reference.sourceRect[key]) throw new Error(`registration sourceRect.${key} 與 immutable reference 不符。`);
      const normalized = key === "x" ? layer.bounds.x : key === "y" ? layer.bounds.y : key === "width" ? layer.bounds.width : layer.bounds.height;
      const extent = key === "x" || key === "width" ? project.canvas.width : project.canvas.height;
      const effective = canonicalizeReferencePixel(normalized, extent);
      if (typeof registeredBounds[key] !== "number" || registeredBounds[key] !== effective) throw new Error(`registration bounds.${key} 與有效圖層 bounds 不符。`);
    }
    if (input.preserveFrame === true) {
      for (const key of ["x", "y", "width", "height"] as const) if (registeredBounds[key] !== frame[key]) throw new Error(`preserveFrame registration bounds.${key} 不等於 sourceRect。`);
    }
  } else if (input?.kind === "landmarks") {
    if (input.preserveFrame !== undefined) throw new Error("landmarks registration 不支援 preserveFrame。");
    const originalPath = resolve(root, registration.originalPath as string);
    const original = await sharp(await readFile(originalPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const solved = solveAssetRegistration(input as Parameters<typeof solveAssetRegistration>[0], original.info);
    for (const key of ["a", "b", "c", "d", "tx", "ty"] as const) {
      if (registration.registration?.matrix?.[key] !== solved.matrix[key]) throw new Error(`landmarks registration matrix.${key} 與不可變輸入重算結果不符。`);
    }
    const raster = rasterizeRegisteredAsset(original.data, original.info.width, original.info.height, solved.matrix, project.canvas);
    for (const key of ["x", "y", "width", "height"] as const) {
      if (registeredBounds[key] !== raster.bounds[key]) throw new Error(`landmarks registration bounds.${key} 與原始 PNG 重算結果不符。`);
      const normalized = key === "x" ? layer.bounds.x : key === "y" ? layer.bounds.y : key === "width" ? layer.bounds.width : layer.bounds.height;
      const extent = key === "x" || key === "width" ? project.canvas.width : project.canvas.height;
      if (!closePixel(canonicalizeReferencePixel(normalized, extent), raster.bounds[key])) throw new Error(`landmarks registration bounds.${key} 與有效圖層 bounds 不符。`);
    }
  } else throw new Error("高密度 PNG 僅支援 frame 或 landmarks registration。");
  const width = Math.round(Number(registeredBounds.width) * (scale as number));
  const height = Math.round(Number(registeredBounds.height) * (scale as number));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw new Error("registration 高密度輸出尺寸超出允許預算。");
  if (layer.mesh.art && (layer.mesh.art.textureSize.width !== width || layer.mesh.art.textureSize.height !== height)) throw new Error("mesh.art.textureSize 與 registration 預期 HD 尺寸不符。");
  return { width, height };
}

export async function verifyProject(projectDirectory: string): Promise<VerifyResult> {
  const root = resolve(projectDirectory);
  const project = await loadProject(root);
  const missingTextures: string[] = [];
  const invalidTextures: Array<{ path: string; reason: string }> = [];
  const sourceIssues: string[] = [];
  const historyIssues: string[] = [];
  const evidenceIssues: string[] = [];
  const withinRoot = (path: string): boolean => {
    const relation = relative(root, path);
    return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  };
  for (const layer of project.layers) {
    const path = resolve(root, layer.texture);
    if (!withinRoot(path)) {
      invalidTextures.push({ path: layer.texture, reason: "纹理路径越过项目目录边界。" });
      continue;
    }
    try {
      await access(path);
      const metadata = await sharp(path).metadata();
      let expectedWidth = Math.round(layer.bounds.width * project.canvas.width);
      let expectedHeight = Math.round(layer.bounds.height * project.canvas.height);
      if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
        try {
          const registered = await registeredHighDensitySize(root, project, layer, path);
          expectedWidth = registered.width;
          expectedHeight = registered.height;
        } catch (error) {
          invalidTextures.push({ path: layer.texture, reason: error instanceof Error ? error.message : "高密度纹理缺少有效 registration 證據。" });
          continue;
        }
      }
      if (metadata.format !== "png" || metadata.width !== expectedWidth || metadata.height !== expectedHeight || !metadata.hasAlpha) {
        invalidTextures.push({ path: layer.texture, reason: `应为 ${expectedWidth}×${expectedHeight} 的透明 PNG，实际为 ${metadata.width ?? "?"}×${metadata.height ?? "?"} ${metadata.format ?? "未知格式"}。` });
      } else {
        await sharp(path).ensureAlpha().raw().toBuffer();
      }
    } catch {
      try { await access(path); invalidTextures.push({ path: layer.texture, reason: "纹理无法解码。" }); }
      catch { missingTextures.push(layer.texture); }
    }
  }
  const hash = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
  const sourceAssets: Array<{ label: string; path: string; expected: string }> = [
    { label: "PSD", path: project.source.psdPath, expected: project.source.psdSha256 },
    ...(project.source.referencePath && project.source.referenceSha256 ? [{ label: "参考图", path: project.source.referencePath, expected: project.source.referenceSha256 }] : [])
  ];
  for (const asset of sourceAssets) {
    const path = resolve(root, asset.path);
    if (!withinRoot(path)) { sourceIssues.push(`${asset.label} 路径越过项目目录边界。`); continue; }
    try {
      if (await hash(path) !== asset.expected) sourceIssues.push(`${asset.label} 内容哈希与项目记录不一致。`);
    } catch {
      sourceIssues.push(`${asset.label} 文件缺失或无法读取。`);
    }
  }
  const [calibration, sessions] = await Promise.all([loadCalibration(root), listCalibrationSessions(root)]);
  let expectedRevision = 0;
  for (const session of sessions) {
    if (session.fromRevision !== expectedRevision || session.toRevision !== expectedRevision + 1) historyIssues.push(`会话 ${session.id} 没有形成连续历史。`);
    expectedRevision = session.toRevision;
    if (session.operationId) {
      const evidenceRoot = session.evidenceDirectory ? resolve(root, session.evidenceDirectory) : "";
      const required = ["comparison.json", "before-evidence.png", "after-evidence.png", "before-after.png", "difference.png"];
      if (!evidenceRoot || !withinRoot(evidenceRoot)) evidenceIssues.push(`会话 ${session.id} 的证据目录无效。`);
      else {
        let comparison: import("./types.js").RevisionComparisonResult | undefined;
        for (const name of required) {
          try {
            const path = join(evidenceRoot, name);
            await access(path);
            if (name.endsWith(".png")) await sharp(path).metadata();
            else comparison = JSON.parse(await readFile(path, "utf8")) as import("./types.js").RevisionComparisonResult;
          } catch {
            evidenceIssues.push(`会话 ${session.id} 缺少或损坏证据 ${name}。`);
          }
        }
        if (comparison?.artifactSha256) {
          const declared = comparison.artifactSha256;
          const paths: Array<[keyof typeof declared, string]> = [
            ["beforeEvidence", "before-evidence.png"], ["afterEvidence", "after-evidence.png"],
            ["comparisonSheet", "before-after.png"], ["differenceImage", "difference.png"]
          ];
          for (const [key, name] of paths) {
            try { if (await hash(join(evidenceRoot, name)) !== declared[key]) evidenceIssues.push(`会话 ${session.id} 的证据 ${name} 哈希不一致。`); }
            catch { /* Missing files are reported above. */ }
          }
        } else {
          evidenceIssues.push(`会话 ${session.id} 的证据清单没有文件哈希。`);
        }
      }
    }
  }
  if (expectedRevision !== calibration.revision) historyIssues.push(`历史末端 revision ${expectedRevision} 与当前 revision ${calibration.revision} 不一致。`);
  if (calibration.headSessionId && sessions.at(-1)?.id !== calibration.headSessionId) historyIssues.push("当前校准头指针与历史末端不一致。" );
  const failedPoses = project.quality.poseValidations.filter((pose) => !pose.passed);
  const warnings = [
    ...project.disabledReasons,
    ...(failedPoses.length > 0 ? [`${failedPoses.length} 个姿态未通过安全检查。`] : []),
    ...(missingTextures.length > 0 ? [`缺少 ${missingTextures.length} 个纹理文件。`] : []),
    ...(invalidTextures.length > 0 ? [`${invalidTextures.length} 个纹理无法用于渲染。`] : []),
    ...sourceIssues,
    ...historyIssues,
    ...evidenceIssues
  ];
  return {
    valid: missingTextures.length === 0 && invalidTextures.length === 0 && sourceIssues.length === 0 && historyIssues.length === 0 && evidenceIssues.length === 0 && failedPoses.length === 0,
    project: project.name,
    rigLevel: project.rigLevel,
    textureCount: project.layers.length,
    missingTextures,
    invalidTextures,
    sourceIssues,
    historyIssues,
    evidenceIssues,
    quality: project.quality,
    warnings
  };
}
