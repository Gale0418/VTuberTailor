export function buildPoses(project, mappedParameterIds = undefined) {
  const parameters = project.model.parameters.filter((item) => !mappedParameterIds || mappedParameterIds.has(item.id));
  const bySemantic = (semantic) => parameters.find((item) => item.semantic === semantic);
  const axes = Object.fromEntries(['head-yaw', 'head-pitch', 'blink', 'blink-left', 'blink-right'].map((key) => [key, bySemantic(key)]));
  const has = (semantic) => Boolean(axes[semantic]);
  const values = (axis, list) => list.map((value) => Math.max(axis.min, Math.min(axis.max, value)));
  const poses = [];
  const headYaw = axes['head-yaw'], headPitch = axes['head-pitch'];
  const yawValues = headYaw ? [headYaw.min, headYaw.default, headYaw.max] : [];
  const pitchValues = headPitch ? [headPitch.min, headPitch.default, headPitch.max] : [];
  const blink = axes.blink;
  if (headYaw && headPitch) {
    for (let yi = 0; yi < 3; yi++) for (let pi = 0; pi < 3; pi++) {
      const parametersForPose = { [headYaw.id]: yawValues[yi], [headPitch.id]: pitchValues[pi] };
      poses.push({ id: `head-${yi}-${pi}`, family: 'nine-way', parameters: parametersForPose, visual: true });
    }
  }
  if (blink) {
    const closed = Math.abs(blink.max - blink.default) >= Math.abs(blink.min - blink.default) ? blink.max : blink.min;
    const blinkValues = [blink.default, blink.default + (closed - blink.default) / 2, closed];
    for (const [i, value] of blinkValues.entries()) poses.push({ id: `blink-${i}`, family: 'blink', parameters: { [blink.id]: value }, visual: i > 0 });
  }
  if (blink && headYaw && headPitch) {
    const closed = Math.abs(blink.max - blink.default) >= Math.abs(blink.min - blink.default) ? blink.max : blink.min;
    for (const [i, value] of [0.5, 1].entries()) poses.push({ id: `head-center-blink-${i}`, family: 'nine-way-blink', parameters: { [headYaw.id]: headYaw.default, [headPitch.id]: headPitch.default, [blink.id]: blink.default + value * (closed - blink.default) }, visual: true });
  }
  const left = axes['blink-left'], right = axes['blink-right'];
  const winksAvailable = Boolean(project.runtime?.features?.asymmetricBlink && blink && left && right);
  if (winksAvailable) {
    const close = (axis) => Math.abs(axis.max - axis.default) >= Math.abs(axis.min - axis.default) ? axis.max : axis.min;
    poses.push({ id: 'wink-left-only', family: 'winks', parameters: { [blink.id]: blink.default, [left.id]: close(left), [right.id]: right.default }, visual: true });
    poses.push({ id: 'wink-right-only', family: 'winks', parameters: { [blink.id]: blink.default, [left.id]: left.default, [right.id]: close(right) }, visual: true });
  }
  for (const parameter of parameters) for (const value of [...new Set([parameter.min, parameter.default, parameter.max])]) {
    poses.push({ id: `extreme-${parameter.id}-${value}`, family: 'parameter-extremes', parameters: { [parameter.id]: value }, visual: false });
  }
  for (let index = 1; index <= 8; index++) poses.push({
    id: `mixed-${index}`, family: 'mixed', visual: index <= 1,
    parameters: Object.fromEntries(parameters.map((parameter, parameterIndex) => [parameter.id, parameter.min + (parameter.max - parameter.min) * ((index * (parameterIndex * 2 + 3) * 0.61803398875) % 1)])),
  });
  return { poses, features: {
    headYaw: has('head-yaw'), headPitch: has('head-pitch'), blink: has('blink'),
    blinkLeft: has('blink-left'), blinkRight: has('blink-right'), asymmetricBlink: winksAvailable,
    availableParameters: parameters.map(({ id, semantic }) => ({ id, semantic: semantic ?? null })),
  } };
}
