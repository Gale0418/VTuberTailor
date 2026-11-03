import { describe, expect, it } from "vitest";
import { neutralMotionState } from "../packages/core/src/deform.js";
import { resolveMotionState } from "../packages/core/src/model.js";
import type { MotionState, PuppetLoomProject } from "../packages/core/src/types.js";
import { previewParameterValue, previewStateWithField, previewStateWithPose } from "../apps/desktop/src/editor/preview-state.js";

function project(parameters: PuppetLoomProject["model"]["parameters"]): PuppetLoomProject {
  return { model: { parameters, expressions: [], physics: [], behaviors: [], bindings: [], deformers: [] } } as PuppetLoomProject;
}

function state(parameters?: Record<string, number>): MotionState {
  return parameters ? { ...neutralMotionState, parameters } : { ...neutralMotionState };
}

describe("desktop preview semantic sliders", () => {
  it("keeps a quick slider effective after an explicit parameter edit", () => {
    const value = project([{ id: "yaw", name: "Yaw", group: "Head", kind: "continuous", min: -1, default: 0, max: 1, semantic: "head-yaw" }]);
    const next = previewStateWithField(value, state({ yaw: 0.8 }), "headYaw", -0.4);
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toBeUndefined();
    expect(resolved.headYaw).toBe(-0.4);
    expect(resolved.parameters?.yaw).toBe(-0.4);
  });

  it("removes every matching semantic override and leaves range resolution to core", () => {
    const value = project([
      { id: "roll-a", name: "Roll A", group: "Head", kind: "continuous", min: -0.25, default: 0, max: 0.25, semantic: "head-roll" },
      { id: "roll-b", name: "Roll B", group: "Head", kind: "continuous", min: -0.5, default: 0, max: 0.5, semantic: "head-roll" }
    ]);
    const next = previewStateWithField(value, state({ "roll-a": 0.2, "roll-b": 0.2 }), "headRoll", 0.8);
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toBeUndefined();
    expect(resolved.headRoll).toBe(0.5);
  });

  it("keeps global blink fallback working with asymmetric parameters", () => {
    const value = project([
      { id: "blink", name: "Blink", group: "Eyes", kind: "continuous", min: 0, default: 0, max: 1, semantic: "blink" },
      { id: "blink-left", name: "Blink Left", group: "Eyes", kind: "continuous", min: 0, default: 0, max: 1, semantic: "blink-left" },
      { id: "blink-right", name: "Blink Right", group: "Eyes", kind: "continuous", min: 0, default: 0, max: 1, semantic: "blink-right" }
    ]);
    const next = previewStateWithField(value, state({ blink: 0.1, "blink-left": 0.2, "blink-right": 0.3 }), "blink", 0.75);
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toBeUndefined();
    expect(resolved.blink).toBe(0.75);
    expect(resolved.blinkLeft).toBe(0.75);
    expect(resolved.blinkRight).toBe(0.75);

    const asymmetric = previewStateWithField(value, { ...state({ blink: 0.1, "blink-left": 0.2, "blink-right": 0.3 }), blinkLeft: 0.2, blinkRight: 0.3 }, "blink", 0.75);
    expect(asymmetric.blinkLeft).toBe(0.75);
    expect(asymmetric.blinkRight).toBe(0.75);
    expect(resolveMotionState(value, asymmetric).blinkLeft).toBe(0.75);
    expect(resolveMotionState(value, asymmetric).blinkRight).toBe(0.75);
  });

  it("lets an active expression compose with a quick slider without an explicit override", () => {
    const value = project([{ id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1, semantic: "smile" }]);
    value.model.expressions = [{ id: "happy", name: "Happy", parameters: { smile: 1 } }];
    const next = previewStateWithField(value, state(), "smile", 0.4);
    next.expressions = { happy: 0.5 };
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toBeUndefined();
    expect(resolved.smile).toBeCloseTo(0.9);
  });

  it("removes a stale semantic override before composing an active expression", () => {
    const value = project([{ id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1, semantic: "smile" }]);
    value.model.expressions = [{ id: "happy", name: "Happy", parameters: { smile: 1 } }];
    const next = previewStateWithField(value, state({ smile: 0.1, unrelated: 0.6 }), "smile", 0.4);
    next.expressions = { happy: 0.5 };
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toEqual({ unrelated: 0.6 });
    expect(resolved.smile).toBeCloseTo(0.9);
  });

  it("leaves an active parameter behavior in control without creating an override", () => {
    const value = project([{ id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1, semantic: "smile" }]);
    value.model.behaviors = [{
      id: "smile-track", name: "Smile Track", duration: 1, loop: false,
      tracks: [{ target: { kind: "parameter", id: "smile" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }]
    }];
    const current = { ...state(), behavior: { id: "smile-track", timeSeconds: 1 } };
    const next = previewStateWithField(value, current, "smile", 0.4);
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toBeUndefined();
    expect(resolved.smile).toBe(1);
  });

  it("does not invent parameter overrides for unmapped fields or missing semantics", () => {
    const value = project([{ id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1, semantic: "smile" }]);
    const current = state({ legacy: 0.4 });

    expect(previewStateWithField(value, current, "hairX", 0.7)).toEqual({ ...current, hairX: 0.7 });
    expect(previewStateWithField(value, current, "headYaw", 0.7)).toEqual({ ...current, headYaw: 0.7 });
  });

  it("keeps the nine-way pose coupling effective across stale, repeated and wrapping parameters", () => {
    const value = project([
      { id: "yaw", name: "Yaw", group: "Head", kind: "continuous", min: -1, default: 0, max: 1, semantic: "head-yaw" },
      { id: "yaw-repeat", name: "Yaw Repeat", group: "Head", kind: "continuous", min: -0.5, default: 0, max: 0.5, semantic: "head-yaw", repeat: true },
      { id: "pitch", name: "Pitch", group: "Head", kind: "continuous", min: -1, default: 0, max: 1, semantic: "head-pitch" },
      { id: "pitch-repeat", name: "Pitch Repeat", group: "Head", kind: "continuous", min: -0.25, default: 0, max: 0.25, semantic: "head-pitch", repeat: true },
      { id: "sway", name: "Sway", group: "Body", kind: "continuous", min: -1, default: 0, max: 1, semantic: "body-sway" },
      { id: "body-pitch", name: "Body Pitch", group: "Body", kind: "continuous", min: -1, default: 0, max: 1, semantic: "body-pitch" },
      { id: "gaze-x", name: "Gaze X", group: "Eyes", kind: "continuous", min: -1, default: 0, max: 1, semantic: "gaze-x" },
      { id: "gaze-y", name: "Gaze Y", group: "Eyes", kind: "continuous", min: -1, default: 0, max: 1, semantic: "gaze-y" }
    ]);
    const next = previewStateWithPose(value, state({
      yaw: -0.9, "yaw-repeat": 0.4, pitch: 0.9, "pitch-repeat": -0.2,
      sway: 0.9, "body-pitch": 0.9, "gaze-x": 0.9, "gaze-y": 0.9, unrelated: 0.6
    }), 0.8, -0.8);
    const resolved = resolveMotionState(value, next);

    expect(next.parameters).toEqual({ unrelated: 0.6 });
    expect(resolved.headYaw).toBeCloseTo(-0.2);
    expect(resolved.headPitch).toBeCloseTo(0.2);
    expect(resolved.bodySway).toBeCloseTo(0.4);
    expect(resolved.bodyPitch).toBeCloseTo(-0.304);
    expect(resolved.gazeX).toBeCloseTo(0.36);
    expect(resolved.gazeY).toBeCloseTo(-0.24);
  });

  it("shows the selected parameter from the same raw-state resolution path as the renderer", () => {
    const value = project([
      { id: "yaw", name: "Yaw", group: "Head", kind: "continuous", min: -1, default: 0, max: 1, semantic: "head-yaw" },
      { id: "yaw-repeat", name: "Yaw Repeat", group: "Head", kind: "continuous", min: -0.5, default: 0, max: 0.5, semantic: "head-yaw", repeat: true },
      { id: "smile", name: "Smile", group: "Face", kind: "continuous", min: 0, default: 0, max: 1, semantic: "smile" }
    ]);
    value.model.expressions = [{ id: "happy", name: "Happy", parameters: { smile: 1 } }];
    value.model.behaviors = [{
      id: "smile-track", name: "Smile Track", duration: 1, loop: false,
      tracks: [{ target: { kind: "parameter", id: "smile" }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.25 }] }]
    }];

    const posed = previewStateWithPose(value, state({ yaw: -0.9, "yaw-repeat": 0.4 }), 0.8, -0.8);
    expect(previewParameterValue(value, posed, "yaw")).toBeCloseTo(0.8);
    expect(previewParameterValue(value, posed, "yaw-repeat")).toBeCloseTo(-0.2);

    const composed = { ...posed, expressions: { happy: 0.5 }, behavior: { id: "smile-track", timeSeconds: 1 } };
    expect(previewParameterValue(value, composed, "smile")).toBeCloseTo(0.25);
    const explicit = { ...composed, parameters: { smile: 0.8 } };
    expect(previewParameterValue(value, explicit, "smile")).toBeCloseTo(0.8);

    const rendererValues = resolveMotionState(value, explicit).parameters!;
    expect(previewParameterValue(value, explicit, "smile")).toBe(rendererValues.smile);
    expect(previewParameterValue(value, explicit, "missing-id")).toBe(rendererValues.yaw);
  });
});
