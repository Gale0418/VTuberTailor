import type { LayerBinding, PuppetLoomProject } from "@puppetloom/core/browser";

/**
 * Find visible layers whose deformation inputs are exactly equivalent. Sharing
 * their deformed positions saves CPU work while each layer still draws its own
 * texture, UVs, triangles, opacity, blend mode, and order.
 */
export function findSharedDeformationGroups(project: PuppetLoomProject): Map<string, string[]> {
  const groupsBySignature = new Map<string, string[]>();
  const boundLayerIds = new Set(project.model.bindings
    .filter((binding) => binding.target.kind === "layer")
    .map((binding) => binding.target.id));
  const collisionLayerIds = new Set((project.runtime.constraints?.collisions ?? [])
    .flatMap((rule) => rule.movingLayerIds));

  for (const layer of project.layers) {
    if (layer.visible === false || layer.deformerId || boundLayerIds.has(layer.id) || collisionLayerIds.has(layer.id)) continue;
    const signature = deformationSignature(layer);
    const group = groupsBySignature.get(signature);
    if (group) group.push(layer.id);
    else groupsBySignature.set(signature, [layer.id]);
  }

  const byLayerId = new Map<string, string[]>();
  for (const ids of groupsBySignature.values()) {
    if (ids.length < 2) continue;
    const group = [...ids];
    for (const id of ids) byLayerId.set(id, group);
  }
  return byLayerId;
}

function deformationSignature(layer: LayerBinding): string {
  return JSON.stringify({
    role: layer.role,
    side: layer.side,
    bounds: layer.bounds,
    pivot: layer.pivot,
    weights: layer.weights,
    parentGroup: layer.parentGroup,
    parentLayerId: layer.parentLayerId,
    deformerId: layer.deformerId,
    headPoseMode: layer.headPoseMode,
    blinkMode: layer.blinkMode,
    garmentStructure: layer.garmentStructure,
    garmentFlexibility: layer.garmentFlexibility,
    headwearPerspective: layer.headwearPerspective,
    secondaryAnchors: layer.secondaryAnchors,
    hairStrands: layer.hairStrands,
    points: layer.mesh.points,
    influences: layer.mesh.influences
  });
}
