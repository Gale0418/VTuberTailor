import { resolveParameterValues } from "@puppetloom/core";
import type { MotionParameterSemantic, MotionState, PuppetLoomProject } from "@puppetloom/core";

/** The semantic fields mirrored by core/model.ts when resolving authored parameters. */
const motionFieldSemantics: Partial<Record<keyof MotionState, MotionParameterSemantic>> = {
  headYaw: "head-yaw",
  headPitch: "head-pitch",
  headRoll: "head-roll",
  bodySway: "body-sway",
  bodyPitch: "body-pitch",
  bodyRoll: "body-roll",
  gazeX: "gaze-x",
  gazeY: "gaze-y",
  breath: "breath",
  blink: "blink",
  blinkLeft: "blink-left",
  blinkRight: "blink-right",
  browLeft: "brow-left",
  browRight: "brow-right",
  smile: "smile",
  cheekPuff: "cheek-puff",
  mouthOpen: "mouth-open",
  mouthA: "mouth-a",
  mouthI: "mouth-i",
  mouthU: "mouth-u",
  mouthE: "mouth-e",
  mouthO: "mouth-o",
  armLeft: "arm-left",
  armRight: "arm-right",
  handLeftX: "hand-left-x",
  handLeftY: "hand-left-y",
  handRightX: "hand-right-x",
  handRightY: "hand-right-y",
  handLeftOpen: "hand-left-open",
  handRightOpen: "hand-right-open",
  earX: "ear-x",
  earY: "ear-y",
  tailX: "tail-x",
  tailY: "tail-y"
};

/**
 * Returns the value shown by the selected-parameter inspector.
 *
 * The editor stores a raw preview state. Resolve it exactly once through the
 * core parameter resolver so semantic fields, expressions, behaviors, repeat
 * ranges, and explicit parameter precedence stay identical to the renderer.
 */
export function previewParameterValue(project: PuppetLoomProject, state: MotionState, selectedId: string): number {
  const parameter = project.model.parameters.find((candidate) => candidate.id === selectedId) ?? project.model.parameters[0];
  if (!parameter) return 0;
  return resolveParameterValues(project, state)[parameter.id] ?? parameter.default;
}

/**
 * Applies a quick semantic preview slider while removing conflicting explicit
 * parameters so core can keep its normal expression/behavior composition.
 */
export function previewStateWithField(project: PuppetLoomProject | undefined, current: MotionState, key: keyof MotionState, value: number): MotionState {
  const next = { ...current, [key]: value } as MotionState;
  const semantic = motionFieldSemantics[key];
  if (!project || !semantic) return next;

  if (semantic === "blink" && typeof current.blinkLeft === "number") next.blinkLeft = value;
  if (semantic === "blink" && typeof current.blinkRight === "number") next.blinkRight = value;

  // core/model.ts lets the global blink field feed asymmetric parameters only
  // when their side fields are absent. Keep absent side fields absent so that
  // fallback remains active, while an already asymmetric preview is made
  // symmetric explicitly by the global slider.
  const targetSemantics = semantic === "blink"
    ? new Set<MotionParameterSemantic>(["blink", "blink-left", "blink-right"])
    : new Set<MotionParameterSemantic>([semantic]);
  const parameters = { ...(current.parameters ?? {}) };
  let removed = false;
  for (const parameter of project.model.parameters) {
    if (!parameter.semantic || !targetSemantics.has(parameter.semantic)) continue;
    if (!(parameter.id in parameters)) continue;
    delete parameters[parameter.id];
    removed = true;
  }
  if (removed) {
    if (Object.keys(parameters).length > 0) next.parameters = parameters;
    else delete next.parameters;
  }
  return next;
}

/** Applies the coupled values used by the editor's nine-way pose pad. */
export function previewStateWithPose(project: PuppetLoomProject | undefined, current: MotionState, yaw: number, pitch: number): MotionState {
  let next = previewStateWithField(project, current, "headYaw", yaw);
  next = previewStateWithField(project, next, "headPitch", pitch);
  next = previewStateWithField(project, next, "bodySway", yaw * 0.5);
  next = previewStateWithField(project, next, "bodyPitch", pitch * 0.38);
  next = previewStateWithField(project, next, "gazeX", yaw * 0.45);
  return previewStateWithField(project, next, "gazeY", pitch * 0.3);
}
