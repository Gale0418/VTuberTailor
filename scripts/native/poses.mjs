/** Collect blink axes on exported eye or face drawables, not unrelated layers. */
export function activeNativeAxes(sourceMap, project) {
  if (!Array.isArray(sourceMap?.layers)) throw new Error('Native source map layers are missing.');
  const sourceLayers = new Map((project.layers ?? []).map((layer) => [layer.id, layer]));
  const parameters = new Map((project.model?.parameters ?? []).map((parameter) => [parameter.id, parameter]));
  const eyeRoles = new Set(['eyeWhite', 'iris', 'eyelash', 'eyeClosed', 'face']);
  const active = new Set();
  for (const layer of sourceMap.layers) {
    if (!Array.isArray(layer.axes)) throw new Error('Native source map layer axes are missing.');
    for (const axis of layer.axes) {
      if (typeof axis.sourceId !== 'string' || !axis.sourceId) throw new Error('Native source map axis sourceId is missing.');
      const source = sourceLayers.get(layer.sourceId), semantic = parameters.get(axis.sourceId)?.semantic;
      if (!source || !eyeRoles.has(source.role)) continue;
      if (semantic === 'blink' || (semantic === 'blink-left' && source.side !== 'right') || (semantic === 'blink-right' && source.side !== 'left')) active.add(axis.sourceId);
    }
  }
  return active;
}

export function buildPoses(project, mappedParameterIds = undefined, activeParameterIds = undefined) {
  const parameters = project.model.parameters.filter((item) => !mappedParameterIds || mappedParameterIds.has(item.id));
  const bySemantic = (semantic) => parameters.find((item) => item.semantic === semantic);
  const axes = Object.fromEntries(['head-yaw', 'head-pitch', 'blink', 'blink-left', 'blink-right'].map((key) => [key, bySemantic(key)]));
  const has = (semantic) => Boolean(axes[semantic]);
  const values = (axis, list) => list.map((value) => Math.max(axis.min, Math.min(axis.max, value)));
  const poses = [];
  const headYaw = axes['head-yaw'], headPitch = axes['head-pitch'];
  const yawValues = headYaw ? [headYaw.min, headYaw.default, headYaw.max] : [];
  const pitchValues = headPitch ? [headPitch.min, headPitch.default, headPitch.max] : [];
  // Keep legacy projects (which omit the feature flag) parameter-driven, but
  // do not advertise or schedule dedicated blink poses when it is disabled.
  const blinkEnabled = project.runtime?.features?.blink !== false;
  const blink = blinkEnabled ? axes.blink : undefined;
  if (activeParameterIds && project.runtime?.features?.blink && !blink) {
    throw new Error('Native blink verification requires a mapped global blink parameter.');
  }
  const left = blinkEnabled ? axes['blink-left'] : undefined, right = blinkEnabled ? axes['blink-right'] : undefined;
  const winksAvailable = Boolean(project.runtime?.features?.asymmetricBlink && blink && left && right
    && (!activeParameterIds || (activeParameterIds.has(left.id) && activeParameterIds.has(right.id))));
  if (activeParameterIds && project.runtime?.features?.blink && blink && !winksAvailable && !activeParameterIds.has(blink.id)) {
    throw new Error('Blink is enabled, but neither the global axis nor both side axes affect an exported drawable.');
  }
  const closeValue = (axis) => Math.abs(axis.max - axis.default) >= Math.abs(axis.min - axis.default) ? axis.max : axis.min;
  const bothEyesAt = (fraction) => winksAvailable
    ? { [blink.id]: blink.default, [left.id]: left.default + fraction * (closeValue(left) - left.default), [right.id]: right.default + fraction * (closeValue(right) - right.default) }
    : { [blink.id]: blink.default + fraction * (closeValue(blink) - blink.default) };
  if (headYaw && headPitch) {
    for (let yi = 0; yi < 3; yi++) for (let pi = 0; pi < 3; pi++) {
      const parametersForPose = { [headYaw.id]: yawValues[yi], [headPitch.id]: pitchValues[pi] };
      poses.push({ id: `head-${yi}-${pi}`, family: 'nine-way', parameters: parametersForPose, visual: true });
    }
  }
  if (blink) {
    for (const [i, fraction] of [0, 0.5, 1].entries()) poses.push({ id: `blink-${i}`, family: 'blink', parameters: bothEyesAt(fraction), visual: i > 0 });
  }
  if (blink && headYaw && headPitch) {
    for (const [i, fraction] of [0.5, 1].entries()) poses.push({ id: `head-center-blink-${i}`, family: 'nine-way-blink', parameters: { [headYaw.id]: headYaw.default, [headPitch.id]: headPitch.default, ...bothEyesAt(fraction) }, visual: true });
  }
  if (winksAvailable) {
    poses.push({ id: 'wink-left-only', family: 'winks', parameters: { [blink.id]: blink.default, [left.id]: closeValue(left), [right.id]: right.default }, visual: true });
    poses.push({ id: 'wink-right-only', family: 'winks', parameters: { [blink.id]: blink.default, [left.id]: left.default, [right.id]: closeValue(right) }, visual: true });
  }
  if (headYaw && headPitch && blink) {
    const variants = winksAvailable
      ? [
        ['both-closed', { [blink.id]: blink.default, [left.id]: closeValue(left), [right.id]: closeValue(right) }],
        ['left-closed', { [blink.id]: blink.default, [left.id]: closeValue(left), [right.id]: right.default }],
        ['right-closed', { [blink.id]: blink.default, [left.id]: left.default, [right.id]: closeValue(right) }],
      ]
      : [['both-closed', { [blink.id]: closeValue(blink) }]];
    for (const yaw of [...new Set([headYaw.min, headYaw.max])]) {
      for (const [variant, parameters] of variants) {
        poses.push({ id: `yaw-blink-${yaw}-${variant}`, family: 'yaw-blink', parameters: { [headYaw.id]: yaw, [headPitch.id]: headPitch.default, ...parameters }, visual: true });
      }
    }
  }
  const headRoll = bySemantic('head-roll');
  if (headYaw && headPitch && headRoll) {
    const openEyes = blink ? { [blink.id]: blink.default, ...(winksAvailable ? { [left.id]: left.default, [right.id]: right.default } : {}) } : {};
    const closedEyes = blink ? (winksAvailable
      ? { [blink.id]: blink.default, [left.id]: closeValue(left), [right.id]: closeValue(right) }
      : { [blink.id]: closeValue(blink) }) : undefined;
    const eyeStates = [['open', openEyes], ...(closedEyes ? [['closed', closedEyes]] : [])];
    const endpoints = (axis) => [...new Set([axis.min, axis.max])];
    for (const [yi, yaw] of endpoints(headYaw).entries()) {
      for (const [pi, pitch] of endpoints(headPitch).entries()) {
        for (const [ri, roll] of endpoints(headRoll).entries()) {
          for (const [state, eyes] of eyeStates) poses.push({
            id: `head-combined-${yi}-${pi}-${ri}-${state}`, family: 'head-combined', visual: true,
            parameters: { [headYaw.id]: yaw, [headPitch.id]: pitch, [headRoll.id]: roll, ...eyes },
          });
        }
      }
    }
    const headAxes = [headYaw, headPitch, headRoll];
    const grids = headAxes.map((axis) => [...new Set([axis.min, axis.default, axis.max])]);
    for (const [yi, yaw] of grids[0].entries()) for (const [pi, pitch] of grids[1].entries()) for (const [ri, roll] of grids[2].entries()) {
      const corner = [yaw, pitch, roll].every((value, index) => endpoints(headAxes[index]).includes(value));
      if (corner) continue;
      for (const [state, eyes] of eyeStates) {
        if (state === 'open' && roll === headRoll.default) continue;
        poses.push({
          id: `head-grid-${yi}-${pi}-${ri}-${state}`, family: 'head-grid', visual: true,
          parameters: { [headYaw.id]: yaw, [headPitch.id]: pitch, [headRoll.id]: roll, ...eyes },
        });
      }
    }
  }
  for (const parameter of parameters) for (const value of [...new Set([parameter.min, parameter.default, parameter.max])]) {
    poses.push({ id: `extreme-${parameter.id}-${value}`, family: 'parameter-extremes', parameters: { [parameter.id]: value }, visual: false });
  }
  for (let index = 1; index <= 8; index++) poses.push({
    id: `mixed-${index}`, family: 'mixed', visual: true,
    parameters: Object.fromEntries(parameters.map((parameter, parameterIndex) => [parameter.id, parameter.min + (parameter.max - parameter.min) * ((index * (parameterIndex * 2 + 3) * 0.61803398875) % 1)])),
  });
  return { poses, features: {
    headYaw: has('head-yaw'), headPitch: has('head-pitch'), blink: Boolean(blink),
    blinkLeft: Boolean(left), blinkRight: Boolean(right), asymmetricBlink: winksAvailable,
    availableParameters: parameters.map(({ id, semantic }) => ({ id, semantic: semantic ?? null })),
  } };
}

export function selectVisualPoses(poses) {
  const wanted = ['head-0-0', 'head-0-1', 'head-0-2', 'head-1-0', 'head-1-1', 'head-1-2', 'head-2-0', 'head-2-1', 'head-2-2', 'blink-1', 'head-center-blink-1', 'wink-left-only', 'wink-right-only', 'mixed-1'];
  const selected = wanted.map((id) => poses.find((pose) => pose.id === id)).filter(Boolean);
  const selectedIds = new Set(selected.map((pose) => pose.id));
  const remaining = poses.filter((pose) => pose.visual && !selectedIds.has(pose.id));
  while (selected.length < Math.min(16, poses.filter((pose) => pose.visual).length) && remaining.length) {
    const pose = remaining.shift();
    selected.push(pose);
    selectedIds.add(pose.id);
  }
  for (const pose of poses) if (pose.visual && ['yaw-blink', 'head-combined', 'head-grid', 'mixed'].includes(pose.family) && !selectedIds.has(pose.id)) {
    selected.push(pose);
    selectedIds.add(pose.id);
  }
  return selected;
}
