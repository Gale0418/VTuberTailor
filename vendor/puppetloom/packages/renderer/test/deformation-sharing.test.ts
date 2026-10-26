import { describe, expect, it } from "vitest";
import type { LayerBinding, PuppetLoomProject } from "@puppetloom/core/browser";
import { findSharedDeformationGroups } from "../src/deformation-sharing.js";

function projectWith(layers: LayerBinding[], bindings: PuppetLoomProject["model"]["bindings"] = [], collisions: NonNullable<PuppetLoomProject["runtime"]["constraints"]>["collisions"] = []): PuppetLoomProject {
  return {
    layers,
    model: { bindings },
    runtime: { constraints: { collisions } }
  } as unknown as PuppetLoomProject;
}

function layer(id: string, overrides: Partial<LayerBinding> = {}): LayerBinding {
  return {
    id,
    role: "leg",
    side: "left",
    visible: true,
    bounds: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
    pivot: { x: 0.25, y: 0.35 },
    weights: { head: 0, body: 1, gaze: 0, physics: 0 },
    mesh: {
      points: [{ x: 0.2, y: 0.3 }, { x: 0.3, y: 0.5 }],
      influences: { body: [1, 0.5] }
    },
    ...overrides
  } as LayerBinding;
}

describe("shared deformation groups", () => {
  it("groups exact duplicate meshes while leaving their draw resources independent", () => {
    const oldLayer = layer("stocking-source");
    const overlay = layer("stocking-hd", { texture: "textures/hd.png", order: 1 });
    const groups = findSharedDeformationGroups(projectWith([oldLayer, overlay]));
    expect(groups.get(oldLayer.id)).toEqual([oldLayer.id, overlay.id]);
    expect(groups.get(overlay.id)).toBe(groups.get(oldLayer.id));
  });

  it("does not share when geometry, authored target, deformer, or collision behavior differs", () => {
    const source = layer("source");
    const changedGeometry = layer("changed-geometry", { mesh: { ...source.mesh, points: [{ ...source.mesh.points[0]!, x: 0.21 }, source.mesh.points[1]!] } });
    const bound = layer("bound");
    const deformed = layer("deformed", { deformerId: "deformer-1" });
    const colliding = layer("colliding");
    const groups = findSharedDeformationGroups(projectWith(
      [source, changedGeometry, bound, deformed, colliding],
      [{ target: { kind: "layer", id: bound.id } } as PuppetLoomProject["model"]["bindings"][number]],
      [{ movingLayerIds: [colliding.id] } as PuppetLoomProject["runtime"]["constraints"]["collisions"][number]]
    ));
    expect(groups.size).toBe(0);
  });

  it("keeps hidden layers out of reusable groups", () => {
    const visible = layer("visible");
    const hidden = layer("hidden", { visible: false });
    expect(findSharedDeformationGroups(projectWith([visible, hidden])).size).toBe(0);
  });
});
