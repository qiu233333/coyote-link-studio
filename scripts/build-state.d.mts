export type BuildStateInspection = {
  sourceFingerprint: string;
  dependencyFingerprint: string;
  needsInstall: boolean;
  needsBuild: boolean;
  reason: string;
};

export function inspectBuildState(
  root?: string,
  nodeMajor?: number,
): BuildStateInspection;
export function invalidateBuild(root?: string): void;
export function invalidateDependencies(root?: string): void;
export function markDependencies(
  root: string,
  expectedDependencyFingerprint: string,
  nodeMajor?: number,
): void;
export function markBuild(
  root: string,
  expectedSourceFingerprint: string,
  nodeMajor?: number,
): void;
