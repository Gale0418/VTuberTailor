import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { canonicalizeReferencePixel, rasterizeRegisteredAsset, solveAssetRegistration, type AssetRegistrationInput } from "./asset-registration.js";
import type { LayerBinding, PuppetLoomProject, Rect } from "./types.js";

const idPattern = /^[a-f0-9]{64}$/;

interface AssetReferenceDocument {
  templateLayerId?: unknown;
  canvas?: { width?: unknown; height?: unknown };
  sourceRect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

interface RegisteredAssetDocument {
  referenceId?: unknown;
  originalPath?: unknown;
  originalSha256?: unknown;
  texture?: unknown;
  textureSha256?: unknown;
  bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  registration?: {
    matrix?: { a?: unknown; b?: unknown; c?: unknown; d?: unknown; tx?: unknown; ty?: unknown };
    input?: {
      kind?: unknown;
      textureScale?: unknown;
      preserveFrame?: unknown;
      sourceRect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    };
  };
}

export interface ValidatedGeneratedAssetProvenance {
  registration: RegisteredAssetDocument;
  reference: AssetReferenceDocument;
  texturePath: string;
  originalPath: string;
  textureScale: number;
  bounds: Rect;
  textureSize: { width: number; height: number };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithinRoot(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

async function isRealPathWithinRoot(realRoot: string, path: string): Promise<boolean> {
  let candidate = path;
  while (true) {
    try {
      return isWithinRoot(realRoot, await realpath(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

function resolveProjectRelativePath(root: string, value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split("/").some((segment) => segment === "..")) return undefined;
  const candidate = resolve(root, normalized);
  return isWithinRoot(root, candidate) ? candidate : undefined;
}

async function readImmutableDocument<T>(root: string, realRoot: string, kind: "references" | "registrations", id: string): Promise<T> {
  if (!idPattern.test(id)) throw new Error(`generatedAsset ${kind === "references" ? "reference" : "registration"} ID 格式無效。`);
  const path = join(root, "assets", kind, `${id}.json`);
  if (!isWithinRoot(root, path) || !(await isRealPathWithinRoot(realRoot, path))) throw new Error(`${kind === "references" ? "reference" : "registration"} 路徑越過專案目錄邊界。`);
  const bytes = await readFile(path);
  if (sha256(bytes) !== id) throw new Error(`${kind === "references" ? "reference" : "registration"} 文件內容與不可變 ${kind === "references" ? "reference" : "registration"} ID 不符。`);
  return JSON.parse(bytes.toString("utf8")) as T;
}

function rectFrom(value: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined, label: string): Rect {
  if (!value || ![value.x, value.y, value.width, value.height].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`${label} 缺少有效 bounds。`);
  }
  return { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number };
}

/**
 * Validate the immutable provenance attached to a generated layer.
 * This is intentionally separate from project-wide verification so callers
 * that persist generated layers can fail closed without changing regular
 * project verification semantics.
 */
export async function validateGeneratedAssetProvenance(
  projectDirectory: string,
  project: PuppetLoomProject,
  layer: LayerBinding
): Promise<ValidatedGeneratedAssetProvenance> {
  const root = resolve(projectDirectory);
  const realRoot = await realpath(root);
  const asset = layer.generatedAsset;
  if (!asset) throw new Error(`圖層 ${layer.id} 沒有 immutable generatedAsset provenance，拒絕分割。`);
  if (!idPattern.test(asset.registrationId)) throw new Error("高密度紋理缺少有效 generatedAsset registration ID。");
  const texturePath = resolveProjectRelativePath(root, layer.texture);
  if (!texturePath || !(await isRealPathWithinRoot(realRoot, texturePath))) throw new Error("generatedAsset texture 路徑越過專案目錄邊界。");
  const textureBytes = await readFile(texturePath);

  const registration = await readImmutableDocument<RegisteredAssetDocument>(root, realRoot, "registrations", asset.registrationId);
  if (registration.referenceId !== asset.referenceId) throw new Error("registration.referenceId 與 generatedAsset 不符。");
  if (registration.originalSha256 !== asset.imageSha256) throw new Error("registration 原始 PNG SHA-256 與 generatedAsset 不符。");
  if (registration.texture !== layer.texture) throw new Error("registration texture path 與圖層 texture 不符。");
  if (typeof registration.textureSha256 !== "string" || sha256(textureBytes) !== registration.textureSha256) throw new Error("texture PNG SHA-256 與 registration 不符。");
  if (typeof registration.originalPath !== "string") throw new Error("registration 缺少有效原始 PNG 路徑。");
  const originalPath = resolveProjectRelativePath(root, registration.originalPath);
  if (!originalPath || !(await isRealPathWithinRoot(realRoot, originalPath))) throw new Error("原始 PNG 路徑越過專案目錄邊界。");
  const originalBytes = await readFile(originalPath);
  if (sha256(originalBytes) !== registration.originalSha256) throw new Error("原始 PNG SHA-256 與 registration 不符。");

  if (!idPattern.test(asset.referenceId)) throw new Error("generatedAsset reference ID 格式無效。");
  const reference = await readImmutableDocument<AssetReferenceDocument>(root, realRoot, "references", asset.referenceId);
  if (reference.templateLayerId !== asset.templateLayerId) throw new Error("reference templateLayerId 與 generatedAsset 不符。");
  if (reference.canvas?.width !== project.canvas.width || reference.canvas?.height !== project.canvas.height) throw new Error("registration reference canvas 與有效模型畫布不符。");

  const original = await sharp(originalBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const registrationInput = registration.registration?.input;
  if (!registrationInput || typeof registrationInput !== "object") throw new Error("registration 缺少不可變配準輸入。");
  const solved = solveAssetRegistration(registrationInput as AssetRegistrationInput, original.info);
  const registeredBounds = rectFrom(registration.bounds, "registration");
  const textureScale = solved.input.textureScale;
  const raster = rasterizeRegisteredAsset(
    original.data,
    original.info.width,
    original.info.height,
    solved.matrix,
    project.canvas,
    solved.input.kind === "frame"
      ? { textureScale, preserveFrame: solved.input.preserveFrame, ...(solved.input.preserveFrame ? { frameBounds: solved.input.sourceRect } : {}) }
      : { textureScale }
  );
  if (solved.input.kind === "frame") {
    const frame = solved.input.sourceRect;
    if (!reference.sourceRect) throw new Error("registration 缺少 frame/sourceRect 證據。");
    for (const key of ["x", "y", "width", "height"] as const) if (frame[key] !== reference.sourceRect[key]) throw new Error(`registration sourceRect.${key} 與 immutable reference 不符。`);
    for (const key of ["x", "y", "width", "height"] as const) {
      const normalized = key === "x" ? layer.bounds.x : key === "y" ? layer.bounds.y : key === "width" ? layer.bounds.width : layer.bounds.height;
      const extent = key === "x" || key === "width" ? project.canvas.width : project.canvas.height;
      if (registeredBounds[key] !== canonicalizeReferencePixel(normalized, extent)) throw new Error(`registration bounds.${key} 與有效圖層 bounds 不符。`);
    }
    if (solved.input.preserveFrame) for (const key of ["x", "y", "width", "height"] as const) if (registeredBounds[key] !== frame[key]) throw new Error(`preserveFrame registration bounds.${key} 不等於 sourceRect。`);
  } else {
    for (const key of ["a", "b", "c", "d", "tx", "ty"] as const) if (registration.registration?.matrix?.[key] !== solved.matrix[key]) throw new Error(`landmarks registration matrix.${key} 與不可變輸入重算結果不符。`);
    for (const key of ["x", "y", "width", "height"] as const) {
      if (registeredBounds[key] !== raster.bounds[key]) throw new Error(`landmarks registration bounds.${key} 與原始 PNG 重算結果不符。`);
      const normalized = key === "x" ? layer.bounds.x : key === "y" ? layer.bounds.y : key === "width" ? layer.bounds.width : layer.bounds.height;
      const extent = key === "x" || key === "width" ? project.canvas.width : project.canvas.height;
      if (Math.abs(canonicalizeReferencePixel(normalized, extent) - raster.bounds[key]) > 1e-6) throw new Error(`landmarks registration bounds.${key} 與有效圖層 bounds 不符。`);
    }
  }

  const textureMetadata = await sharp(textureBytes).metadata();
  const textureSize = { width: Math.round(registeredBounds.width * textureScale), height: Math.round(registeredBounds.height * textureScale) };
  if (textureMetadata.format !== "png" || textureMetadata.width !== textureSize.width || textureMetadata.height !== textureSize.height || !textureMetadata.hasAlpha) {
    throw new Error(`registration texture 尺寸或格式不符，應為 ${textureSize.width}×${textureSize.height} 的透明 PNG。`);
  }
  if (layer.mesh.art && (layer.mesh.art.textureSize.width !== textureSize.width || layer.mesh.art.textureSize.height !== textureSize.height)) throw new Error("mesh.art.textureSize 與 registration 預期尺寸不符。");
  return { registration, reference, texturePath, originalPath, textureScale, bounds: registeredBounds, textureSize };
}
