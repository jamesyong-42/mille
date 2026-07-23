import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const ACTIONS = new Set([
  'copyAbsolutePath',
  'copyRelativePath',
  'revealInFileManager',
  'openContainingFolder',
  'openTerminal',
]);

export function resolvePlaygroundFileAction(request, activeWorkspaceRoot) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('file action request must be an object');
  }
  if (!ACTIONS.has(request.action)) {
    throw new TypeError(`unsupported file action: ${String(request.action)}`);
  }
  if (
    typeof request.workspaceRoot !== 'string' ||
    request.workspaceRoot.length === 0 ||
    request.workspaceRoot !== activeWorkspaceRoot
  ) {
    throw new Error('file action workspace does not match the active workspace');
  }
  if (typeof request.rootRelativePath !== 'string') {
    throw new TypeError('file action path must be a string');
  }
  const path = request.rootRelativePath.replace(/\\/g, '/');
  const segments = path.length === 0 ? [] : path.split('/');
  if (
    path.startsWith('/') ||
    isAbsolute(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('file action path must stay below the workspace root');
  }
  const workspaceRoot = resolve(activeWorkspaceRoot);
  const absolutePath = resolve(workspaceRoot, ...segments);
  const containment = relative(workspaceRoot, absolutePath);
  if (containment === '..' || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw new Error('file action escaped the workspace root');
  }
  return Object.freeze({
    action: request.action,
    absolutePath,
    relativePath: path.length === 0 ? '.' : path,
  });
}

export async function performPlaygroundFileAction(request, dependencies) {
  const action = resolvePlaygroundFileAction(request, dependencies.activeWorkspaceRoot);
  if (action.action === 'copyAbsolutePath') {
    dependencies.writeClipboard(action.absolutePath);
    return { action: action.action, value: action.absolutePath };
  }
  if (action.action === 'copyRelativePath') {
    dependencies.writeClipboard(action.relativePath);
    return { action: action.action, value: action.relativePath };
  }
  if (action.action === 'revealInFileManager') {
    dependencies.revealInFileManager(action.absolutePath);
    return { action: action.action, value: action.absolutePath };
  }

  const directory = dependencies.isDirectory(action.absolutePath)
    ? action.absolutePath
    : dirname(action.absolutePath);
  if (action.action === 'openContainingFolder') {
    await dependencies.openPath(directory);
    return { action: action.action, value: directory };
  }
  await dependencies.openTerminal(directory);
  return { action: action.action, value: directory };
}

export function terminalLaunchSpec(platform, directory, environment = {}) {
  if (platform === 'darwin') {
    return Object.freeze({
      command: 'open',
      args: Object.freeze(['-a', 'Terminal', directory]),
      cwd: directory,
    });
  }
  if (platform === 'win32') {
    return Object.freeze({
      command: 'cmd.exe',
      args: Object.freeze(['/d', '/s', '/c', 'start', '', 'cmd.exe']),
      cwd: directory,
    });
  }
  const configured =
    typeof environment.TERMINAL === 'string' && environment.TERMINAL.trim().length > 0
      ? environment.TERMINAL.trim()
      : 'x-terminal-emulator';
  return Object.freeze({
    command: configured,
    args: Object.freeze([]),
    cwd: directory,
  });
}
