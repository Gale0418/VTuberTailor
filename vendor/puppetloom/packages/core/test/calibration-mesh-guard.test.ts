import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import {
  createProject,
  loadCalibration,
  loadProject,
  loadProjectRevision,
  restoreCalibrationRevision,
  saveAuthoringPatch,
  saveCalibrationPatch
} from "../src/index.js";

const outputs = ["indexed", "plain", "explicit-model", "historical"].map((name) => artifactPath(`calibration-mesh-guard-${name}-${process.pid}-${Date.now()}`));

beforeAll(async () => {
  await Promise.all(outputs.map((output) => createProject({ input: resolve("test/fixtures/semantic.psd"), output, seed: 42 })));
}, 120_000);

async function gridLayer(output: string) {
  const project = await loadProject(output);
  const layer = project.layers.find((candidate) => candidate.mesh.topology === "grid");
  if (!layer || layer.mesh.rows === undefined || layer.mesh.cols === undefined) throw new Error("合成 mesh guard fixture 缺少 grid layer。");
  return { project, layer };
}

function denser(layer: Awaited<ReturnType<typeof gridLayer>>["layer"]): { rows: number; cols: number } {
  return { rows: Math.min(64, layer.mesh.rows! + 1), cols: Math.min(64, layer.mesh.cols! + 1) };
}

describe("calibration mesh indexed-data guard", () => {
  it("rejects a new density write when a layer binding still carries vertex deltas", async () => {
    const output = outputs[0]!;
    const { project, layer } = await gridLayer(output);
    const yaw = project.model.parameters.find((parameter) => parameter.semantic === "head-yaw");
    if (!yaw) throw new Error("合成 mesh guard fixture 缺少 head-yaw parameter。");

    await saveAuthoringPatch(output, {
      version: 1,
      baseRevision: 0,
      operations: [{
        op: "upsert-binding",
        binding: {
          id: "synthetic-indexed-layer-binding",
          parameterIds: [yaw.id],
          target: { kind: "layer", id: layer.id },
          keyforms: [
            { values: [yaw.min] },
            { values: [yaw.max], meshPointDeltas: { "0": { x: 0.001, y: 0 } } }
          ]
        }
      }, {
        op: "upsert-binding",
        binding: {
          id: "synthetic-indexed-layer-binding-two",
          parameterIds: [yaw.id],
          target: { kind: "layer", id: layer.id },
          keyforms: [
            { values: [yaw.min] },
            { values: [yaw.max], meshPointDeltas: { "0": { x: 0.002, y: 0 } } }
          ]
        }
      }]
    });

    await expect(saveCalibrationPatch(output, {
      baseRevision: 1,
      overrides: { layers: { [layer.id]: { meshDensity: denser(layer) } } }
    })).rejects.toThrow(/vertex remap|顶点增量/);
    expect((await loadCalibration(output)).revision).toBe(1);
  }, 120_000);

  it("allows a density write when the affected layer has no indexed keyform data", async () => {
    const output = outputs[1]!;
    const { layer } = await gridLayer(output);
    const saved = await saveCalibrationPatch(output, {
      baseRevision: 0,
      overrides: { layers: { [layer.id]: { meshDensity: denser(layer) } } }
    });
    expect(saved.calibration.revision).toBe(1);
    expect(saved.project.layers.find((candidate) => candidate.id === layer.id)?.mesh.points.length)
      .toBe(denser(layer).rows * denser(layer).cols);
  }, 120_000);

  it("allows a full-model snapshot hand-off without validating remap correctness", async () => {
    const output = outputs[2]!;
    const { project, layer } = await gridLayer(output);
    const yaw = project.model.parameters.find((parameter) => parameter.semantic === "head-yaw");
    if (!yaw) throw new Error("合成 mesh guard fixture 缺少 head-yaw parameter。");
    const model = structuredClone(project.model);
    model.bindings.push({
      id: "synthetic-explicit-remapped-binding",
      parameterIds: [yaw.id],
      target: { kind: "layer", id: layer.id },
      keyforms: [
        { values: [yaw.min] },
        { values: [yaw.max], meshPointDeltas: { "0": { x: 0.001, y: 0 } } }
      ]
    });
    const saved = await saveCalibrationPatch(output, {
      baseRevision: 0,
      overrides: { model, layers: { [layer.id]: { meshDensity: denser(layer) } } }
    });
    expect(saved.calibration.revision).toBe(1);
  }, 120_000);

  it("keeps historical indexed snapshots readable and restorable", async () => {
    const output = outputs[3]!;
    const { project, layer } = await gridLayer(output);
    const yaw = project.model.parameters.find((parameter) => parameter.semantic === "head-yaw");
    if (!yaw) throw new Error("合成 mesh guard fixture 缺少 head-yaw parameter。");

    const density = await saveCalibrationPatch(output, {
      baseRevision: 0,
      overrides: { layers: { [layer.id]: { meshDensity: denser(layer) } } }
    });
    expect(density.calibration.revision).toBe(1);

    const historical = await saveAuthoringPatch(output, {
      version: 1,
      baseRevision: 1,
      operations: [{
        op: "upsert-binding",
        binding: {
          id: "synthetic-historical-indexed-binding",
          parameterIds: [yaw.id],
          target: { kind: "layer", id: layer.id },
          keyforms: [
            { values: [yaw.min] },
            { values: [yaw.max], meshPointDeltas: { "0": { x: 0.001, y: 0 } } }
          ]
        }
      }]
    });
    expect(historical.calibration.revision).toBe(2);
    await expect(loadProjectRevision(output, 2)).resolves.toBeDefined();

    const followUp = await saveCalibrationPatch(output, {
      baseRevision: 2,
      overrides: { runtime: { motionTuning: { response: 0.81 } } }
    });
    expect(followUp.calibration.revision).toBe(3);
    const restored = await restoreCalibrationRevision(output, 2, 3, "重播歷史 indexed snapshot");
    expect(restored.calibration.revision).toBe(4);
    await expect(loadProjectRevision(output, 4)).resolves.toBeDefined();
  }, 120_000);
});
