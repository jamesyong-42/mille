export type PlaygroundFileAction =
  | 'copyAbsolutePath'
  | 'copyRelativePath'
  | 'revealInFileManager'
  | 'openContainingFolder'
  | 'openTerminal';

export interface PlaygroundFileActionRequest {
  readonly action: PlaygroundFileAction;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
}

export interface PlaygroundFileActionResult {
  readonly action: PlaygroundFileAction;
  readonly value: string;
}

export interface PlaygroundFileActionDependencies {
  readonly activeWorkspaceRoot: string;
  writeClipboard(value: string): void;
  revealInFileManager(path: string): void;
  isDirectory(path: string): boolean;
  openPath(path: string): void | Promise<void>;
  openTerminal(path: string): void | Promise<void>;
}

export interface TerminalLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function resolvePlaygroundFileAction(
  request: unknown,
  activeWorkspaceRoot: string,
): Readonly<{
  action: PlaygroundFileAction;
  absolutePath: string;
  relativePath: string;
}>;

export function performPlaygroundFileAction(
  request: unknown,
  dependencies: PlaygroundFileActionDependencies,
): Promise<PlaygroundFileActionResult>;

export function terminalLaunchSpec(
  platform: NodeJS.Platform,
  directory: string,
  environment?: Readonly<Record<string, string | undefined>>,
): TerminalLaunchSpec;
