export declare function parseWorkspaceRoots(
  raw: string | undefined,
  primary: string,
): string[];

export declare function resolveTrustedRoot(
  requested: unknown,
  openRoots: readonly string[],
): string;
