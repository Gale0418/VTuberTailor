import { describe, expect, it } from "vitest";
import { deformPoint, deformedPoints, neutralMotionState } from "../src/deform.js";
import { createDefaultAuthoringModel, evaluateLayerAuthoring, ModelPhysicsController, resolveMotionState, resolveParameterValues } from "../src/model.js";
import { parsePuppetLoomProject } from "../src/project-format.js";
import { authoredLayersInRenderOrder, authoredOpacityFor } from "../src/render-contract.js";
import { puppetLoomProjectSchema } from "../src/schema.js";
import type { AuthoringModel, LayerBinding, PuppetLoomProject } from "../src/types.js";

function layer(id = "layer", order = 0): LayerBinding {
  return {
    id, sourceName: id, sourcePath: [id], role: "accessory", side: "center", order, opacity: 1, blendMode: "normal",
    bounds: { x: 0, y: 0, width: 1, height: 1 }, texture: `textures/${id}.png`, pivot: { x: 0, y: 0 },
    mesh: {
      rows: 2, cols: 2,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      triangles: [0, 1, 2, 1, 3, 2]
    },
    weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root"
  };
}

function project(model: AuthoringModel = createDefaultAuthoringModel(), layers = [layer()]): PuppetLoomProject {
  return {
    version: 3, name: "authoring-model", canvas: { width: 100, height: 100 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "minimal", layers, model, anchors: {},
    runtime: {
      seed: 1, profile: "calm-v1",
      envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

describe("AI authoring model", () => {
  it("maps semantic fields into parameters while explicit values win and clamp", () => {
    const value = resolveMotionState(project(), {
      ...neutralMotionState,
      headYaw: -0.4,
      parameters: { "param-head-yaw": 9 }
    });
    expect(value.headYaw).toBe(1);
    expect(value.parameters?.["param-head-yaw"]).toBe(1);
  });

  it("interpolates layer mesh, opacity and draw order from one custom parameter", () => {
    const custom = { id: "smile", name: "Smile", group: "Expression", kind: "continuous" as const, min: 0, default: 0, max: 1 };
    const first = layer("first", 0);
    const second = layer("second", 1);
    const value = project({
      parameters: [...createDefaultAuthoringModel().parameters, custom], deformers: [],
      bindings: [{
        id: "smile-first", parameterIds: [custom.id], target: { kind: "layer", id: first.id },
        keyforms: [
          { values: [0], meshPointDeltas: { "1": { x: 0, y: 0 } }, opacityMultiplier: 1, drawOrderOffset: 0 },
          { values: [1], meshPointDeltas: { "1": { x: 0.2, y: 0.1 } }, opacityMultiplier: 0.5, drawOrderOffset: 3 }
        ]
      }]
    }, [first, second]);
    const state = { ...neutralMotionState, parameters: { smile: 0.5 } };
    const evaluated = evaluateLayerAuthoring(value, first, state);
    expect(evaluated.points[1]).toEqual({ x: 1.1, y: 0.05 });
    expect(authoredOpacityFor(value, first, state)).toBeCloseTo(0.75);
    expect(authoredLayersInRenderOrder(value, state).map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("switches directly between closed and open art when the slight mouth is inactive", () => {
    const closed = { ...layer("mouth-closed"), role: "mouth" as const, mouthVariant: "closed" as const };
    const slight = { ...layer("mouth-slight"), role: "mouth" as const, mouthVariant: "slight" as const, visible: false };
    const open = { ...layer("mouth-open"), role: "mouth" as const, mouthVariant: "open" as const };
    const value = project(createDefaultAuthoringModel(), [closed, slight, open]);
    value.runtime.features.mouthMotion = true;

    expect(authoredOpacityFor(value, closed, { ...neutralMotionState, mouthOpen: 0.49 })).toBe(1);
    expect(authoredOpacityFor(value, open, { ...neutralMotionState, mouthOpen: 0.49 })).toBe(0);
    expect(authoredOpacityFor(value, closed, { ...neutralMotionState, mouthOpen: 0.5 })).toBe(0);
    expect(authoredOpacityFor(value, open, { ...neutralMotionState, mouthOpen: 0.5 })).toBe(1);
  });

  it("bilinearly samples a complete two-parameter keyform grid", () => {
    const parameters = [
      { id: "x", name: "X", group: "Custom", kind: "continuous" as const, min: 0, default: 0, max: 1 },
      { id: "y", name: "Y", group: "Custom", kind: "continuous" as const, min: 0, default: 0, max: 1 }
    ];
    const value = project({ parameters, deformers: [], bindings: [{
      id: "xy", parameterIds: ["x", "y"], target: { kind: "layer", id: "layer" },
      keyforms: [
        { values: [0, 0], meshPointDeltas: { "0": { x: 0, y: 0 } } },
        { values: [1, 0], meshPointDeltas: { "0": { x: 1, y: 0 } } },
        { values: [0, 1], meshPointDeltas: { "0": { x: 0, y: 1 } } },
        { values: [1, 1], meshPointDeltas: { "0": { x: 1, y: 1 } } }
      ]
    }] });
    expect(deformedPoints(value, value.layers[0]!, { ...neutralMotionState, parameters: { x: 0.25, y: 0.75 } })[0]).toEqual({ x: 0.25, y: 0.75 });
  });

  it("applies a child deformer before its parent", () => {
    const attached = { ...layer(), deformerId: "child" };
    const value = project({
      parameters: [{ id: "turn", name: "Turn", group: "Custom", kind: "continuous", min: 0, default: 0, max: 1 }],
      deformers: [
        { id: "parent", name: "Parent", kind: "rotation", pivot: { x: 0, y: 0 } },
        { id: "child", name: "Child", kind: "rotation", parentId: "parent", pivot: { x: 0, y: 0 } }
      ],
      bindings: ["child", "parent"].map((id) => ({
        id: `turn-${id}`, parameterIds: ["turn"] as [string], target: { kind: "deformer" as const, id },
        keyforms: [{ values: [0] as [number] }, { values: [1] as [number], transform: { rotationDegrees: 90 } }]
      }))
    }, [attached]);
    const points = deformedPoints(value, attached, { ...neutralMotionState, parameters: { turn: 1 } });
    expect(points[1]!.x).toBeCloseTo(-1);
    expect(points[1]!.y).toBeCloseTo(0);
  });

  it("keeps neck roll attachment anatomical when a parent XY deformer moves the layer", () => {
    const neck = { ...layer("neck"), role: "neck" as const, weights: { head: 1, body: 0, gaze: 0, physics: 0 } };
    const value = project({
      parameters: [{ id: "shift", name: "Shift", group: "Custom", kind: "continuous", min: 0, default: 0, max: 1 }],
      deformers: [{ id: "parent", name: "Parent", kind: "rotation", pivot: { x: 0, y: 0 } }],
      bindings: [{
        id: "shift-parent", parameterIds: ["shift"], target: { kind: "deformer", id: "parent" },
        keyforms: [
          { values: [0], transform: { translation: { x: 0, y: 0 } } },
          { values: [1], transform: { translation: { x: 0, y: 0.4 } } }
        ]
      }]
    }, [{ ...neck, deformerId: "parent" }]);
    value.runtime.envelope.headRollDegrees = 20;
    const pivot = { x: 0.5, y: 0.42 };
    const point = (shift: number, roll: number, index: number) => deformedPoints(value, value.layers[0]!, {
      ...neutralMotionState, headRoll: roll, parameters: { shift }
    })[index]!;
    const angularDelta = (from: { x: number; y: number }, to: { x: number; y: number }) =>
      Math.atan2(to.y - pivot.y, to.x - pivot.x) - Math.atan2(from.y - pivot.y, from.x - pivot.x);
    const topNeutral = point(0, 0, 0), topNeutralRolled = point(0, 1, 0);
    const topShifted = point(1, 0, 0), topShiftedRolled = point(1, 1, 0);
    expect(angularDelta(topNeutral, topNeutralRolled)).toBeCloseTo(20 * Math.PI / 180, 8);
    expect(angularDelta(topShifted, topShiftedRolled)).toBeCloseTo(angularDelta(topNeutral, topNeutralRolled), 8);

    const bottomShifted = point(1, 0, 2), bottomShiftedRolled = point(1, 1, 2);
    expect(Math.hypot(bottomShiftedRolled.x - bottomShifted.x, bottomShiftedRolled.y - bottomShifted.y)).toBeLessThan(1e-10);

    const arbitrary = { x: 0, y: 0.4 };
    const fallback = deformPoint(value, value.layers[0]!, arbitrary, { ...neutralMotionState, headRoll: 1 });
    const indexed = deformPoint(value, value.layers[0]!, arbitrary, { ...neutralMotionState, headRoll: 1 }, 0);
    expect(angularDelta(arbitrary, fallback)).toBeLessThan(angularDelta(arbitrary, indexed) - 0.05);
    expect(angularDelta(arbitrary, indexed)).toBeCloseTo(20 * Math.PI / 180, 8);
  });

  it("keeps a dynamic head surface continuous across the body-sway boundary", () => {
    const neck = { ...layer("neck"), headPoseMode: "keyforms" as const };
    const model = {
      ...createDefaultAuthoringModel(),
      parameters: [
        { id: "yaw", name: "Yaw", group: "Head", kind: "continuous" as const, min: -1, default: 0, max: 1, semantic: "head-yaw" as const },
        { id: "pitch", name: "Pitch", group: "Head", kind: "continuous" as const, min: -1, default: 0, max: 1, semantic: "head-pitch" as const },
        { id: "body", name: "Body", group: "Body", kind: "continuous" as const, min: -1, default: 0, max: 1, semantic: "body-sway" as const }
      ],
      bindings: [
        {
          id: "head-surface", parameterIds: ["yaw", "pitch"] as [string, string], target: { kind: "layer" as const, id: neck.id },
          keyforms: [
            { values: [-1, -1] as [number, number], meshPointDeltas: { "0": { x: 0, y: 0 }, "1": { x: 10, y: 0 }, "2": { x: 0, y: 0 }, "3": { x: 10, y: 0 } } },
            { values: [1, -1] as [number, number], meshPointDeltas: { "0": { x: 0, y: 0 }, "1": { x: 10, y: 0 }, "2": { x: 0, y: 0 }, "3": { x: 10, y: 0 } } },
            { values: [-1, 1] as [number, number], meshPointDeltas: { "0": { x: 0, y: 0 }, "1": { x: 10, y: 0 }, "2": { x: 0, y: 0 }, "3": { x: 10, y: 0 } } },
            { values: [1, 1] as [number, number], meshPointDeltas: { "0": { x: 0, y: 0 }, "1": { x: 10, y: 0 }, "2": { x: 0, y: 0 }, "3": { x: 10, y: 0 } } }
          ]
        },
        {
          id: "body-sway", parameterIds: ["body"] as [string], target: { kind: "layer" as const, id: neck.id },
          keyforms: [
            { values: [-1] as [number], meshPointDeltas: { "0": { x: -1, y: 0 } } },
            { values: [1] as [number], meshPointDeltas: { "0": { x: 1, y: 0 } } }
          ]
        }
      ]
    } satisfies AuthoringModel;
    const value = project(model, [neck]);
    const pointAt = (body: number) => evaluateLayerAuthoring(value, neck, {
      ...neutralMotionState, parameters: { yaw: 0, pitch: 0, body }
    }).points[0]!;
    const before = pointAt(-0.35 + 1e-7);
    const after = pointAt(-0.35 - 1e-7);

    expect(Math.abs(before.x - after.x)).toBeLessThan(1e-4);
    expect(Math.abs(before.y - after.y)).toBeLessThan(1e-8);
    expect(pointAt(0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(-1).x).toBeGreaterThanOrEqual(-1);
    expect(pointAt(-1).x).toBeLessThanOrEqual(0);
  });

  it("migrates a real legacy-shaped document in memory without requiring model data", () => {
    const current = project();
    const { model: _model, ...legacy } = current;
    const migrated = parsePuppetLoomProject({ ...legacy, version: 2 });
    expect(migrated.version).toBe(4);
    expect(migrated.model.parameters.find((parameter) => parameter.semantic === "head-yaw")).toBeDefined();
    expect(migrated.layers).toEqual(current.layers.map((layer) => ({ ...layer, mesh: { ...layer.mesh, topology: "grid" } })));

    const authoredV3 = parsePuppetLoomProject(current);
    expect(authoredV3.version).toBe(4);
    expect(authoredV3.model).toEqual(current.model);
    expect(authoredV3.layers[0]?.mesh.topology).toBe("grid");
  });

  it("rejects missing targets and incomplete two-axis grids at the JSON boundary", () => {
    const invalid = project({
      parameters: [
        { id: "x", name: "X", group: "Custom", kind: "continuous", min: 0, default: 0, max: 1 },
        { id: "y", name: "Y", group: "Custom", kind: "continuous", min: 0, default: 0, max: 1 }
      ],
      deformers: [],
      bindings: [{
        id: "invalid", parameterIds: ["x", "y"], target: { kind: "layer", id: "missing" },
        keyforms: [{ values: [0, 0] }, { values: [1, 1] }]
      }]
    });
    const result = puppetLoomProjectSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "绑定目标不存在。", "双参数绑定必须提供完整的矩形关键形态网格。"
    ]));
  });

  it("combines named expressions with autoplay behavior and keeps explicit parameters authoritative", () => {
    const model = createDefaultAuthoringModel();
    model.parameters.push({ id: "smile", name: "Smile", group: "Expression", kind: "continuous", min: 0, default: 0, max: 1 });
    model.expressions.push({ id: "happy", name: "Happy", parameters: { smile: 1 } });
    model.behaviors.push({
      id: "idle-expression", name: "Idle Expression", duration: 1, loop: false, autoplay: true,
      tracks: [{ target: { kind: "expression", id: "happy" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1, easing: "linear" }] }]
    });
    const value = project(model);
    expect(resolveParameterValues(value, { ...neutralMotionState, timeSeconds: 0.5 }).smile).toBeCloseTo(0.5);
    expect(resolveParameterValues(value, { ...neutralMotionState, timeSeconds: 0.5, parameters: { smile: 0.2 } }).smile).toBe(0.2);
    expect(resolveParameterValues(value, { ...neutralMotionState, expressions: { happy: 0.75 } }).smile).toBe(0.75);
    expect(resolveParameterValues(value, { ...neutralMotionState, behavior: { id: "idle-expression", timeSeconds: 1, weight: 0.4 } }).smile).toBeCloseTo(0.4);
  });

  it("runs authored parameter physics deterministically and lets an explicit output override it", () => {
    const model = createDefaultAuthoringModel();
    model.parameters.push(
      { id: "drive", name: "Drive", group: "Physics", kind: "continuous", min: -1, default: 0, max: 1 },
      { id: "lag", name: "Lag", group: "Physics", kind: "continuous", min: -1, default: 0, max: 1 }
    );
    model.physics.push({ id: "drive-lag", name: "Drive Lag", inputParameterId: "drive", outputParameterId: "lag", inputScale: 1, outputScale: 1, response: 10, damping: 1 });
    const value = project(model);
    const left = new ModelPhysicsController(value);
    const right = new ModelPhysicsController(value);
    const outputs = Array.from({ length: 60 }, (_, index) => {
      const state = { ...neutralMotionState, parameters: { drive: 1 }, timeSeconds: index / 60 };
      return [left.sample(state).parameters!.lag!, right.sample(state).parameters!.lag!];
    });
    expect(outputs.every(([a, b]) => a === b)).toBe(true);
    expect(outputs[0]![0]).toBeGreaterThan(0);
    expect(outputs.at(-1)![0]).toBeGreaterThan(0.98);
    expect(left.sample({ ...neutralMotionState, parameters: { drive: 1, lag: -0.5 }, timeSeconds: 1.1 }).parameters!.lag).toBe(-0.5);
  });
});
