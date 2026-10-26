import { deformedPoints, neutralMotionState } from "./deform.js";
import { clamp, rectCenter, rectUnion } from "./math.js";
import { authoredOpacityFor } from "./render-contract.js";
import { characterLayerVisible } from "./character-state.js";
import type {
  LayerBinding,
  MotionEnvelope,
  MotionState,
  Point,
  PoseValidation,
  PuppetLoomProject,
  QualitySummary,
  Rect,
  RigLevel,
  ValidationIssue
} from "./types.js";

export const safetyPoses: Array<{ id: string; yaw: number; pitch: number; roll: number }> = [
  { id: "neutral", yaw: 0, pitch: 0, roll: 0 },
  { id: "yaw-left", yaw: -1, pitch: 0, roll: 0 },
  { id: "yaw-right", yaw: 1, pitch: 0, roll: 0 },
  { id: "yaw-left-half", yaw: -0.5, pitch: 0, roll: 0 },
  { id: "yaw-right-half", yaw: 0.5, pitch: 0, roll: 0 },
  { id: "pitch-up", yaw: 0, pitch: -1, roll: 0 },
  { id: "pitch-down", yaw: 0, pitch: 1, roll: 0 },
  { id: "roll-left", yaw: 0, pitch: 0, roll: -1 },
  { id: "roll-right", yaw: 0, pitch: 0, roll: 1 },
  { id: "corner-left-up", yaw: -0.7, pitch: -0.55, roll: -0.25 },
  { id: "corner-right-up", yaw: 0.7, pitch: -0.55, roll: 0.25 },
  { id: "corner-left-down", yaw: -0.7, pitch: 0.55, roll: 0.25 },
  { id: "corner-right-down", yaw: 0.7, pitch: 0.55, roll: -0.25 }
];

export function safetyPoseState(yaw: number, pitch: number, roll: number): MotionState {
  return {
    headYaw: yaw,
    headPitch: pitch,
    headRoll: roll,
    bodySway: yaw * 0.5,
    bodyPitch: pitch * 0.38,
    bodyRoll: roll * 0.35 + yaw * 0.12,
    gazeX: yaw * 0.45,
    gazeY: pitch * 0.3,
    breath: pitch > 0 ? 0.35 : -0.2,
    hairX: -yaw * 0.018,
    hairY: -pitch * 0.008,
    ahogeX: -yaw * 0.032,
    ahogeY: -pitch * 0.014,
    backHairX: -yaw * 0.045,
    backHairY: -pitch * 0.02,
    headwearX: -yaw * 0.012,
    headwearY: -pitch * 0.006,
    earX: -yaw * 0.012,
    earY: -(Math.abs(yaw) + Math.abs(pitch)) * 0.018,
    clothX: -yaw * 0.018,
    clothY: -pitch * 0.008,
    tailX: -yaw * 0.075,
    tailY: -pitch * 0.032,
    accessoryX: -yaw * 0.055,
    accessoryY: -pitch * 0.025,
    blink: 0,
    mouthOpen: 0
  };
}

function signedArea(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function meshContainsPoint(points: Point[], triangles: number[], point: Point): boolean {
  for (let index = 0; index < triangles.length; index += 3) {
    const a = points[triangles[index]!], b = points[triangles[index + 1]!], c = points[triangles[index + 2]!];
    if (!a || !b || !c || Math.abs(signedArea(a, b, c)) < 1e-12) continue;
    const areas = [signedArea(a, b, point), signedArea(b, c, point), signedArea(c, a, point)];
    if (areas.every((area) => area >= -1e-12) || areas.every((area) => area <= 1e-12)) return true;
  }
  return false;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointsRect(points: Point[]): Rect {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { x: minX, y: minY, width: Math.max(1e-6, maxX - minX), height: Math.max(1e-6, maxY - minY) };
}

function layerMeshIssues(project: PuppetLoomProject, layer: LayerBinding, state: MotionState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = layer.mesh.points;
  const current = deformedPoints(project, layer, state);
  for (let index = 0; index < layer.mesh.triangles.length; index += 3) {
    const ia = layer.mesh.triangles[index];
    const ib = layer.mesh.triangles[index + 1];
    const ic = layer.mesh.triangles[index + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const a0 = base[ia];
    const b0 = base[ib];
    const c0 = base[ic];
    const a1 = current[ia];
    const b1 = current[ib];
    const c1 = current[ic];
    if (!a0 || !b0 || !c0 || !a1 || !b1 || !c1) continue;
    const baseArea = signedArea(a0, b0, c0);
    const currentArea = signedArea(a1, b1, c1);
    if (baseArea * currentArea <= 0 || Math.abs(currentArea) < Math.abs(baseArea) * 0.08) {
      const areaRatio = Math.abs(baseArea) > 1e-12 ? currentArea / baseArea : 0;
      issues.push({
        code: "mesh-inversion",
        severity: "error",
        message: `${layer.sourceName} 的网格三角形 ${index / 3}（顶点 ${ia}/${ib}/${ic}）发生翻转或塌陷，面积比 ${areaRatio.toFixed(4)}。`,
        layerId: layer.id
      });
      break;
    }
    const baseLongest = Math.max(distance(a0, b0), distance(b0, c0), distance(c0, a0), 1e-6);
    const currentLongest = Math.max(distance(a1, b1), distance(b1, c1), distance(c1, a1));
    if (currentLongest / baseLongest > 1.8) {
      issues.push({ code: "mesh-stretch", severity: "error", message: `${layer.sourceName} 的局部拉伸超过安全范围。`, layerId: layer.id });
      break;
    }
  }
  const bounds = pointsRect(current);
  if (bounds.x < -0.1 || bounds.y < -0.1 || bounds.x + bounds.width > 1.1 || bounds.y + bounds.height > 1.1) {
    issues.push({ code: "viewport-overflow", severity: "error", message: `${layer.sourceName} 超出安全画布。`, layerId: layer.id });
  }
  return issues;
}

function relationshipIssues(project: PuppetLoomProject, state: MotionState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const currentRects = new Map<string, Rect>();
  const currentPoints = new Map<string, Point[]>();
  const neutralRects = new Map<string, Rect>();
  for (const layer of project.layers) {
    const points = deformedPoints(project, layer, state);
    currentPoints.set(layer.id, points);
    currentRects.set(layer.id, pointsRect(points));
    neutralRects.set(layer.id, pointsRect(deformedPoints(project, layer, neutralMotionState)));
  }

  for (const iris of project.layers.filter((layer) => layer.role === "iris" && layer.clipLayerId)) {
    const eye = iris.clipLayerId ? currentRects.get(iris.clipLayerId) : undefined;
    const eyeLayer = iris.clipLayerId ? project.layers.find((layer) => layer.id === iris.clipLayerId) : undefined;
    const neutralEye = iris.clipLayerId ? neutralRects.get(iris.clipLayerId) : undefined;
    const irisRect = currentRects.get(iris.id);
    if (!eye || !irisRect) continue;
    const paddingX = eye.width * 0.16;
    const paddingY = eye.height * 0.2;
    const geometryMask = eyeLayer?.role === "eyeWhite"
      && eyeLayer.blinkMode === "geometry"
      && eyeLayer.side === iris.side
      && eyeLayer.visible !== false
      && characterLayerVisible(project, eyeLayer.id, state)
      && neutralEye !== undefined;
    const geometryBlink = geometryMask
      && eye.height < neutralEye.height * 0.9;
    const irisCenterX = irisRect.x + irisRect.width * 0.5;
    const irisCenterY = irisRect.y + irisRect.height * 0.5;
    // A masked iris may extend behind the upper/lower eyelid even at neutral.
    // Keep its pupil center inside the open mask and bound its diameter by the
    // neutral eye's long axis; an oversized or displaced iris is still invalid.
    const maskedIrisOutside = geometryMask && (
      irisRect.height > neutralEye.width
      || (!geometryBlink && !meshContainsPoint(currentPoints.get(eyeLayer.id)!, eyeLayer.mesh.triangles, { x: irisCenterX, y: irisCenterY }))
    );
    if (
      irisRect.x < eye.x - paddingX ||
      irisRect.x + irisRect.width > eye.x + eye.width + paddingX ||
      maskedIrisOutside ||
      (geometryMask
        ? irisCenterY < eye.y - paddingY || irisCenterY > eye.y + eye.height + paddingY
        : irisRect.y < eye.y - paddingY || irisRect.y + irisRect.height > eye.y + eye.height + paddingY)
    ) {
      issues.push({ code: "eye-outside", severity: "error", message: `${iris.sourceName} 离开眼部安全区域。`, layerId: iris.id });
    }
  }

  const faces = project.layers.filter((layer) => layer.role === "face");
  const face = faces[0];
  const hair = project.layers.filter((layer) => layer.role === "frontHair" || layer.role === "backHair" || layer.role === "sideHair");
  if (faces.length > 0 && hair.length > 0) {
    const faceNow = rectUnion(faces.map((layer) => currentRects.get(layer.id)).filter((rect): rect is Rect => Boolean(rect)));
    const faceNeutral = rectUnion(faces.map((layer) => neutralRects.get(layer.id)).filter((rect): rect is Rect => Boolean(rect)));
    const hairNow = rectUnion(hair.map((layer) => currentRects.get(layer.id)).filter((rect): rect is Rect => Boolean(rect)));
    const hairNeutral = rectUnion(hair.map((layer) => neutralRects.get(layer.id)).filter((rect): rect is Rect => Boolean(rect)));
    if (faceNow && faceNeutral && hairNow && hairNeutral) {
      const neutralDistance = distance(rectCenter(faceNeutral), rectCenter(hairNeutral));
      const currentDistance = distance(rectCenter(faceNow), rectCenter(hairNow));
      if (Math.abs(currentDistance - neutralDistance) > Math.max(faceNeutral.width, faceNeutral.height) * 0.13) {
        issues.push({ code: "face-hair-separation", severity: "error", message: "脸部和头发的相对位置发生明显分离。" });
      }
    }
  }

  const neck = project.layers.find((layer) => layer.role === "neck");
  if (face && neck) {
    const faceNow = currentRects.get(face.id);
    const faceNeutral = neutralRects.get(face.id);
    const neckNow = currentRects.get(neck.id);
    const neckNeutral = neutralRects.get(neck.id);
    if (faceNow && faceNeutral && neckNow && neckNeutral) {
      const neutralDistance = distance(rectCenter(faceNeutral), rectCenter(neckNeutral));
      const currentDistance = distance(rectCenter(faceNow), rectCenter(neckNow));
      if (Math.abs(currentDistance - neutralDistance) > faceNeutral.height * 0.12) {
        issues.push({ code: "neck-separation", severity: "error", message: "脖子和脸部的相对位置超过安全范围。" });
      }
    }
  }
  return issues;
}

export function validatePose(project: PuppetLoomProject, id: string, state: MotionState): PoseValidation {
  // Match the rasterizer: fully transparent artwork has no visible mesh to validate,
  // but a transparent layer still needs valid geometry when an opaque layer uses it
  // as a clip mask.
  const renderableLayers = project.layers.filter((layer) => layer.visible !== false
    && characterLayerVisible(project, layer.id, state)
    && authoredOpacityFor(project, layer, state) > 0);
  const activeClipIds = new Set(renderableLayers.filter((layer) => layer.clipLayerId).map((layer) => layer.clipLayerId!));
  const renderableLayerIds = new Set(renderableLayers.map((layer) => layer.id));
  const activeLayers = project.layers.filter((layer) => renderableLayerIds.has(layer.id) || activeClipIds.has(layer.id));
  const activeProject = activeLayers.length === project.layers.length ? project : { ...project, layers: activeLayers };
  const issues = [...activeLayers.flatMap((layer) => layerMeshIssues(activeProject, layer, state)), ...relationshipIssues(activeProject, state)];
  const deduplicated = [...new Map(issues.map((issue) => [`${issue.code}:${issue.layerId ?? "project"}`, issue])).values()];
  const penalty = deduplicated.reduce((sum, issue) => sum + (issue.severity === "error" ? 0.28 : 0.08), 0);
  return {
    id,
    headYaw: state.headYaw,
    headPitch: state.headPitch,
    headRoll: state.headRoll,
    score: clamp(1 - penalty, 0, 1),
    passed: !deduplicated.some((issue) => issue.severity === "error"),
    issues: deduplicated
  };
}

export function validateProjectPoses(project: PuppetLoomProject): PoseValidation[] {
  return safetyPoses.map((pose) => validatePose(project, pose.id, safetyPoseState(pose.yaw, pose.pitch, pose.roll)));
}

function scaleEnvelope(envelope: MotionEnvelope, scale: number): MotionEnvelope {
  return {
    ...envelope,
    headYaw: envelope.headYaw * scale,
    headPitch: envelope.headPitch * scale,
    headRollDegrees: envelope.headRollDegrees * scale,
    bodySway: envelope.bodySway * scale,
    bodyRollDegrees: envelope.bodyRollDegrees * scale,
    gazeX: envelope.gazeX * scale,
    gazeY: envelope.gazeY * scale,
    breath: envelope.breath * Math.max(0.55, scale)
  };
}

function envelopeForFallback(level: RigLevel): MotionEnvelope {
  if (level === "grouped") return { headYaw: 0.3, headPitch: 0.2, headRollDegrees: 1.8, bodySway: 0.006, bodyRollDegrees: 0.8, gazeX: 0, gazeY: 0, breath: 0.003, globalScale: 1 };
  return { headYaw: 0, headPitch: 0, headRollDegrees: 0.7, bodySway: 0.004, bodyRollDegrees: 0.5, gazeX: 0, gazeY: 0, breath: 0.0025, globalScale: 1 };
}

function downgrade(project: PuppetLoomProject, level: RigLevel): PuppetLoomProject {
  const layers = project.layers.map((layer) => ({
    ...layer,
    weights:
      level === "minimal"
        ? { head: 0, body: 0, gaze: 0, physics: 0 }
        : { ...layer.weights, gaze: 0, physics: Math.min(layer.weights.physics, 0.35) }
  }));
  return {
    ...project,
    rigLevel: level,
    layers,
    runtime: {
      ...project.runtime,
      envelope: envelopeForFallback(level),
      features: {
        ...project.runtime.features,
        headTurn: level !== "minimal",
        gaze: false,
        hairPhysics: level !== "minimal" && project.runtime.features.hairPhysics,
        blink: project.runtime.features.blink
      }
    },
    disabledReasons: [...project.disabledReasons, level === "minimal" ? "复杂变形未通过安全检查，已切换为整体保守运动。" : "完整语义变形未通过安全检查，已切换为分组运动。"]
  };
}

function qualityFrom(project: PuppetLoomProject, poses: PoseValidation[], scale: number): QualitySummary {
  const issues = [...new Map(poses.flatMap((pose) => pose.issues).map((issue) => [`${issue.code}:${issue.layerId ?? "project"}`, issue])).values()];
  return {
    ...(project.quality.neutralSimilarity === undefined ? {} : { neutralSimilarity: project.quality.neutralSimilarity }),
    poseValidations: poses,
    safetyScale: scale,
    issues
  };
}

export function applySafetyLimits(input: PuppetLoomProject): PuppetLoomProject {
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
  const originalEnvelope = input.runtime.envelope;
  const existingScale = clamp(input.quality.safetyScale, 0, 1);
  for (const scale of scales) {
    const project = { ...input, runtime: { ...input.runtime, envelope: scaleEnvelope(originalEnvelope, scale) } };
    const poses = validateProjectPoses(project);
    if (poses.every((pose) => pose.passed)) return { ...project, quality: qualityFrom(project, poses, existingScale * scale) };
  }

  if (input.rigLevel === "semantic") return applySafetyLimits(downgrade(input, "grouped"));
  if (input.rigLevel === "grouped") return applySafetyLimits(downgrade(input, "minimal"));
  const poses = validateProjectPoses(input);
  return { ...input, quality: qualityFrom(input, poses, existingScale * 0.25) };
}
