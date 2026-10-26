import { describe, expect, it } from "vitest";
import { deformedPoints } from "../src/deform.js";
import { makeGridMesh } from "../src/rig.js";
import { applySafetyLimits, safetyPoseState, validatePose } from "../src/safety.js";
import { neutralMotionState } from "../src/deform.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

describe("mesh and safety", () => {
  const makeClippedGeometryEye = (irisBounds: { x: number; y: number; width: number; height: number }) => {
    const eyeBounds = { x: 0.3, y: 0.3, width: 0.4, height: 0.2 };
    const makeLayer = (id: string, role: "eyeWhite" | "iris", bounds: typeof eyeBounds): LayerBinding => ({
      id, sourceName: id, sourcePath: [id], role, side: "left" as const, order: role === "eyeWhite" ? 0 : 1, opacity: 1,
      blinkMode: "geometry" as const, blendMode: "normal", bounds, texture: `textures/${id}.png`,
      pivot: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, mesh: makeGridMesh(bounds, 3, 3),
      weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" as const
    });
    const eye = makeLayer("eye-white", "eyeWhite", eyeBounds);
    const iris = makeLayer("iris", "iris", irisBounds);
    iris.clipLayerId = eye.id;
    const closeDeltas = Object.fromEntries(eye.mesh.points.map((point, index) => [String(index), {
      x: 0,
      y: (0.05 - 1) * (point.y - (eyeBounds.y + eyeBounds.height / 2))
    }]));
    const project = {
      canvas: { width: 512, height: 512 }, layers: [eye, iris], anchors: {},
      model: {
        parameters: [{ id: "param-blink-left", name: "Blink Left", group: "Eyes", kind: "continuous", min: 0, default: 0, max: 1, semantic: "blink-left" }],
        deformers: [], expressions: [], physics: [], behaviors: [],
        bindings: [{ id: "geometry-eye-blink", parameterIds: ["param-blink-left"], blinkMode: "geometry", target: { kind: "layer", id: eye.id }, keyforms: [
          { values: [0] }, { values: [1], meshPointDeltas: closeDeltas }
        ] }]
      },
      runtime: { seed: 1, profile: "calm-v1", features: { blink: true, asymmetricBlink: true, mouthMotion: false, visemes: false }, envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as unknown as PuppetLoomProject;
    return project;
  };

  const halfBlinkState = {
    ...neutralMotionState,
    blinkLeft: 0.5,
    parameters: { "param-blink-left": 0.5 }
  };

  it("skips transparent mesh geometry but keeps transparent clip masks in safety checks", () => {
    const makeLayer = (id: string, role: "eyeWhite" | "iris", order: number) => {
      const bounds = { x: 0.3, y: 0.3, width: 0.4, height: 0.2 };
      const mesh = makeGridMesh(bounds, 3, 3);
      mesh.points[1] = { ...mesh.points[0]! }; // Deliberately degenerate first triangle.
      return {
        id, sourceName: id, sourcePath: [id], role, side: "left" as const, order, opacity: 1,
        blinkMode: "texture" as const, blendMode: "normal", bounds, texture: `textures/${id}.png`,
        pivot: { x: 0.5, y: 0.4 }, mesh,
        weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" as const
      };
    };
    const mask = makeLayer("mask", "eyeWhite", 0);
    const iris = makeLayer("iris", "iris", 1);
    iris.clipLayerId = mask.id;
    const project = {
      canvas: { width: 512, height: 512 }, layers: [mask], anchors: {},
      model: {
        parameters: [{ id: "visibility", name: "Visibility", group: "Test", kind: "continuous", min: 0, default: 0, max: 1 }],
        deformers: [], expressions: [], physics: [], behaviors: [],
        bindings: [{ id: "mask-hidden", parameterIds: ["visibility"], target: { kind: "layer", id: mask.id }, keyforms: [{ values: [0], opacityMultiplier: 0 }, { values: [1], opacityMultiplier: 0 }] }]
      },
      runtime: { seed: 1, profile: "calm-v1", features: { blink: true, asymmetricBlink: true, mouthMotion: false, visemes: false }, envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as unknown as PuppetLoomProject;

    expect(validatePose(project, "transparent-mask", neutralMotionState).issues.some((issue) => issue.code === "mesh-inversion" && issue.layerId === mask.id)).toBe(false);

    project.model = { ...project.model!, bindings: [{ ...project.model!.bindings[0]!, keyforms: [{ values: [0], opacityMultiplier: 0.5 }, { values: [1], opacityMultiplier: 0.5 }] }] };
    expect(validatePose(project, "partial-opacity", neutralMotionState).issues.some((issue) => issue.code === "mesh-inversion" && issue.layerId === mask.id)).toBe(true);
    project.model = { ...project.model!, bindings: [{ ...project.model!.bindings[0]!, keyforms: [{ values: [0], opacityMultiplier: 0 }, { values: [1], opacityMultiplier: 0 }] }] };

    project.layers.push(iris);
    expect(validatePose(project, "transparent-used-as-clip", neutralMotionState).issues.some((issue) => issue.code === "mesh-inversion" && issue.layerId === mask.id)).toBe(true);
  });

  it("continues to reject a visible half-blink triangle inversion", () => {
    const bounds = { x: 0.3, y: 0.3, width: 0.4, height: 0.2 };
    const layer = {
      id: "upper-lash", sourceName: "upper lash", sourcePath: ["upper lash"], role: "eyelash" as const, side: "left" as const,
      order: 0, opacity: 1, blinkMode: "geometry" as const, blendMode: "normal", bounds, texture: "textures/lash.png",
      pivot: { x: 0.5, y: 0.4 }, mesh: makeGridMesh(bounds, 3, 3),
      weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" as const
    };
    const project = {
      canvas: { width: 512, height: 512 }, layers: [layer], anchors: {},
      model: {
        parameters: [{ id: "param-blink-left", name: "Blink Left", group: "Eyes", kind: "continuous", min: 0, default: 0, max: 1, semantic: "blink-left" }],
        deformers: [], expressions: [], physics: [], behaviors: [],
        bindings: [{ id: "lash-blink", parameterIds: ["param-blink-left"], target: { kind: "layer", id: layer.id }, keyforms: [
          { values: [0], opacityMultiplier: 1 }, { values: [1], opacityMultiplier: 1, meshPointDeltas: { "1": { x: -0.5, y: 0 } } }
        ] }]
      },
      runtime: { seed: 1, profile: "calm-v1", features: { blink: true, asymmetricBlink: true, mouthMotion: false, visemes: false }, envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as unknown as PuppetLoomProject;
    const halfBlink = { ...neutralMotionState, blinkLeft: 0.5, parameters: { "param-blink-left": 0.5 } };
    expect(validatePose(project, "visible-half-blink", halfBlink).issues.some((issue) => issue.code === "mesh-inversion" && issue.layerId === layer.id)).toBe(true);
  });

  it("allows iris clipping in a geometry half-blink while keeping containment checks", () => {
    const clipped = makeClippedGeometryEye({ x: 0.38, y: 0.31, width: 0.24, height: 0.18 });
    const halfBlink = validatePose(clipped, "geometry-half-blink-clipped", halfBlinkState);
    expect(halfBlink.passed).toBe(true);
    expect(halfBlink.issues.some((issue) => issue.code === "eye-outside")).toBe(false);

    const horizontalDrift = makeClippedGeometryEye({ x: 0.67, y: 0.31, width: 0.12, height: 0.18 });
    expect(validatePose(horizontalDrift, "geometry-half-blink-horizontal-drift", halfBlinkState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));

    const verticalDrift = makeClippedGeometryEye({ x: 0.38, y: 0.5, width: 0.24, height: 0.18 });
    expect(validatePose(verticalDrift, "geometry-half-blink-vertical-drift", halfBlinkState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
  });

  it("still rejects an oversized iris while the geometry eye is open", () => {
    const project = makeClippedGeometryEye({ x: 0.2, y: 0.22, width: 0.6, height: 0.56 });
    const open = validatePose(project, "geometry-eye-open-oversized-iris", {
      ...neutralMotionState,
      blinkLeft: 0,
      parameters: { "param-blink-left": 0 }
    });
    expect(open.issues).toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
  });

  it("allows neutral eyelid occlusion only for a same-eye geometry mask", () => {
    const project = makeClippedGeometryEye({ x: 0.38, y: 0.24, width: 0.24, height: 0.28 });
    expect(validatePose(project, "neutral-masked-eyelid", neutralMotionState).passed).toBe(true);
    project.layers[0]!.side = "right";
    expect(validatePose(project, "wrong-eye-mask", neutralMotionState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
    project.layers[0]!.side = "left";
    project.layers[0]!.blinkMode = "texture";
    expect(validatePose(project, "non-geometry-mask", neutralMotionState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
    project.layers[0]!.blinkMode = "geometry";
    project.layers[0]!.visible = false;
    expect(validatePose(project, "hidden-geometry-mask", neutralMotionState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
  });

  it("rejects a vertically oversized masked iris and a pupil outside mask triangles", () => {
    const oversized = makeClippedGeometryEye({ x: 0.38, y: 0.17, width: 0.24, height: 0.46 });
    expect(validatePose(oversized, "vertical-diameter-too-large", neutralMotionState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
    const missingPupil = makeClippedGeometryEye({ x: 0.52, y: 0.38, width: 0.12, height: 0.24 });
    // Its center is in the eye bounding rectangle, but outside the mask's one triangle.
    missingPupil.layers[0]!.mesh.triangles = [0, 1, 3];
    expect(validatePose(missingPupil, "pupil-outside-mask-shape", neutralMotionState).issues)
      .toContainEqual(expect.objectContaining({ code: "eye-outside", layerId: "iris" }));
  });

  const makeFaceHairProject = (splitFace: boolean, faceDrift = 0) => {
    const makeLayer = (id: string, role: "face" | "frontHair", order: number, bounds: { x: number; y: number; width: number; height: number }): LayerBinding => {
      const mesh = makeGridMesh(bounds, 3, 3);
      return {
        id, sourceName: id, sourcePath: [id], role, side: "center", order, opacity: 1, blendMode: "normal",
        bounds, texture: `textures/${id}.png`, pivot: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, mesh,
        weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "head",
        headPoseMode: "keyforms"
      };
    };
    const faceBounds = { x: 0.4, y: 0.25, width: 0.2, height: 0.3 };
    const hairBounds = { x: 0.4, y: 0.08, width: 0.2, height: 0.12 };
    const faceLayers = splitFace
      ? [
          // Lower underlay deliberately comes first, as in the split r27 face.
          makeLayer("neck-underlay", "face", 8, { x: 0.4, y: 0.42, width: 0.2, height: 0.13 }),
          makeLayer("top-face", "face", 10, { x: 0.4, y: 0.25, width: 0.2, height: 0.17 })
        ]
      : [makeLayer("single-face", "face", 9, faceBounds)];
    const hair = makeLayer("front-hair", "frontHair", 20, hairBounds);
    const bindingFor = (layer: LayerBinding) => ({
      id: `translate-${layer.id}`, parameterIds: ["param-face-hair-translation"], target: { kind: "layer" as const, id: layer.id },
      keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: Object.fromEntries(layer.mesh.points.map((_, index) => {
        const point = layer.mesh.points[index]!;
        const localV = (point.y - layer.bounds.y) / layer.bounds.height;
        const movement = layer.role === "frontHair"
          ? 0.05
          : faceDrift + ((!splitFace || layer.id === "top-face") ? 0.05 * (1 - localV) : 0);
        return [String(index), { x: 0, y: movement }];
      })) }]
    });
    const layers = [...faceLayers, hair];
    return {
      project: {
        canvas: { width: 512, height: 512 }, layers, anchors: {},
        model: {
          parameters: [{ id: "param-face-hair-translation", name: "Face and hair translation", group: "Test", kind: "continuous", min: 0, default: 0, max: 1 }],
          deformers: [], expressions: [], physics: [], behaviors: [], bindings: layers.map(bindingFor)
        },
        runtime: { seed: 1, profile: "calm-v1", features: { blink: true, asymmetricBlink: true, mouthMotion: false, visemes: false }, envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
      } as unknown as PuppetLoomProject,
      state: { ...neutralMotionState, parameters: { "param-face-hair-translation": 1 } }
    };
  };

  it("uses the union of split face surfaces for face-hair separation", () => {
    const singleFace = makeFaceHairProject(false);
    const splitFace = makeFaceHairProject(true);
    const singleResult = validatePose(singleFace.project, "single-face-same-pose", singleFace.state);
    const splitResult = validatePose(splitFace.project, "split-face-same-pose", splitFace.state);

    expect(singleResult.issues.some((issue) => issue.code === "face-hair-separation")).toBe(false);
    expect(splitResult.issues.some((issue) => issue.code === "face-hair-separation")).toBe(false);
    expect(splitResult.passed).toBe(singleResult.passed);

    const driftingSplitFace = makeFaceHairProject(true, 0.2);
    expect(validatePose(driftingSplitFace.project, "split-face-true-drift", driftingSplitFace.state).issues)
      .toContainEqual(expect.objectContaining({ code: "face-hair-separation" }));
  });

  it("creates a complete rectangular triangle grid", () => {
    const mesh = makeGridMesh({ x: 0.2, y: 0.1, width: 0.4, height: 0.5 }, 4, 5);
    expect(mesh.points).toHaveLength(20);
    expect(mesh.uvs).toHaveLength(20);
    expect(mesh.triangles).toHaveLength((4 - 1) * (5 - 1) * 6);
    expect(Math.max(...mesh.triangles)).toBeLessThan(mesh.points.length);
  });

  it("preserves neutral mesh points exactly", () => {
    const layer = {
      id: "layer", sourceName: "face", sourcePath: ["face"], role: "face" as const, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.2, y: 0.1, width: 0.5, height: 0.6 }, texture: "textures/layer.png",
      pivot: { x: 0.45, y: 0.4 }, mesh: makeGridMesh({ x: 0.2, y: 0.1, width: 0.5, height: 0.6 }, 4, 4),
      weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" as const
    };
    const project = {
      canvas: { width: 512, height: 512 }, layers: [layer], anchors: {},
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0.2, headPitch: 0.1, headRollDegrees: 5, bodySway: 0.1, bodyRollDegrees: 3, breath: 0.02, gazeX: 0.2, gazeY: 0.1, globalScale: 1 } }
    } as PuppetLoomProject;
    expect(deformedPoints(project, layer, safetyPoseState(0, 0, 0))).toEqual(layer.mesh.points);
  });

  it("keeps legs and feet fixed during breathing", () => {
    const makeLayer = (role: "topWear" | "leg" | "foot", y: number) => ({
      id: role, sourceName: role, sourcePath: [role], role, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.35, y, width: 0.3, height: 0.18 }, texture: `textures/${role}.png`,
      pivot: { x: 0.5, y: y + 0.09 }, mesh: makeGridMesh({ x: 0.35, y, width: 0.3, height: 0.18 }, 4, 4),
      weights: { head: 0, body: 1, gaze: 0, physics: 0 }, parentGroup: "body" as const
    });
    const layers = [makeLayer("topWear", 0.42), makeLayer("leg", 0.65), makeLayer("foot", 0.82)];
    const project = {
      canvas: { width: 512, height: 512 }, layers, anchors: { bodyCenter: { x: 0.5, y: 0.55 } },
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0.01, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as PuppetLoomProject;
    const breathing = { ...safetyPoseState(0, 0, 0), breath: 1 };
    expect(deformedPoints(project, layers[1]!, breathing)).toEqual(layers[1]!.mesh.points);
    expect(deformedPoints(project, layers[2]!, breathing)).toEqual(layers[2]!.mesh.points);
    expect(deformedPoints(project, layers[0]!, breathing)).not.toEqual(layers[0]!.mesh.points);
  });

  it("pins the headband while flexible ear tips follow secondary motion", () => {
    const layer = {
      id: "headwear", sourceName: "headwear", sourcePath: ["headwear"], role: "headwear" as const, side: "center" as const, order: 0, opacity: 1,
      blendMode: "normal", bounds: { x: 0.2, y: 0.08, width: 0.6, height: 0.28 }, texture: "textures/headwear.png",
      pivot: { x: 0.5, y: 0.15 }, mesh: makeGridMesh({ x: 0.2, y: 0.08, width: 0.6, height: 0.28 }, 5, 5),
      secondaryAnchors: { earHingeLeft: { x: 0.38, y: 0.19 }, earHingeRight: { x: 0.62, y: 0.19 } },
      weights: { head: 1, body: 0, gaze: 0, physics: 0.55 }, parentGroup: "head" as const
    };
    const project = {
      canvas: { width: 512, height: 512 }, layers: [layer], anchors: { neck: { x: 0.5, y: 0.35 }, cheekLeft: { x: 0.62, y: 0.24 }, cheekRight: { x: 0.38, y: 0.24 }, forehead: { x: 0.5, y: 0.12 }, chin: { x: 0.5, y: 0.3 } },
      runtime: { seed: 42, profile: "calm-v1", envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, breath: 0, gazeX: 0, gazeY: 0, globalScale: 1 } }
    } as PuppetLoomProject;
    const state = { ...safetyPoseState(0, 0, 0), earX: 1, earY: 0.4 };
    const moved = deformedPoints(project, layer, state);
    expect(moved[2]).toEqual(layer.mesh.points[2]);
    expect(moved[20]).not.toEqual(layer.mesh.points[20]);
    expect(moved[24]).not.toEqual(layer.mesh.points[24]);
  });

  it("shrinks or downgrades an unsafe envelope", () => {
    const mesh = makeGridMesh({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, 4, 4);
    const project = {
      version: 1, generator: { name: "PuppetLoom", version: "0.1.0" }, name: "unsafe", createdAt: "deterministic",
      canvas: { width: 512, height: 512 }, source: { originalFileName: "unsafe.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" },
      rigLevel: "semantic", layers: [{ id: "face", sourceName: "face", sourcePath: ["face"], role: "face", side: "center", order: 0, opacity: 1, blendMode: "normal", bounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, texture: "textures/face.png", pivot: { x: 0.5, y: 0.5 }, mesh, weights: { head: 1, body: 0, gaze: 0, physics: 0 }, parentGroup: "head" }],
      anchors: { neck: { x: 0.5, y: 0.9 }, cheekLeft: { x: 0.9, y: 0.5 }, cheekRight: { x: 0.1, y: 0.5 }, forehead: { x: 0.5, y: 0.1 }, chin: { x: 0.5, y: 0.9 } },
      runtime: { seed: 1, profile: "calm-v1", envelope: { headYaw: 18, headPitch: 12, headRollDegrees: 160, bodySway: 3, bodyRollDegrees: 90, breath: 1, gazeX: 4, gazeY: 4, globalScale: 1 }, features: { headTurn: true, bodyFollow: true, gaze: false, hairPhysics: false, blink: false, mouthMotion: false } },
      quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
    } as PuppetLoomProject;
    const safe = applySafetyLimits(project);
    const safeAgain = applySafetyLimits(safe);
    expect(safe.quality.poseValidations).toHaveLength(13);
    expect(safe.quality.poseValidations.every((pose) => pose.passed)).toBe(true);
    expect(safe.quality.safetyScale < 1 || safe.rigLevel !== "semantic").toBe(true);
    expect(safeAgain.runtime.envelope).toEqual(safe.runtime.envelope);
    expect(safeAgain.quality.safetyScale).toBe(safe.quality.safetyScale);
  });
});
