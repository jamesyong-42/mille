import { appendFile, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const FILE_KIND = 0;
const DIRECTORY_KIND = 1;

function payload(length, marker) {
  const prefix = `${marker}:`;
  return prefix + 'x'.repeat(Math.max(0, length - prefix.length));
}

function safePath(root, relative) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relative);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`benchmark path escapes workspace: ${relative}`);
  }
  return absolute;
}

function cycleOperations(cycle) {
  const suffix = String(cycle).padStart(4, '0');
  const directory = `bench-dir-${suffix}`;
  const renamedDirectory = `bench-renamed-${suffix}`;
  const created = `created-${suffix}.txt`;
  const renamed = `renamed-${suffix}.txt`;
  const copied = `copied-${suffix}.txt`;
  const nestedDirectory = `nested-${suffix}`;
  const renamedNestedDirectory = `nested-renamed-${suffix}`;
  const nestedFile = `nested-file-${suffix}.txt`;

  return [
    {
      kind: 'mkdir',
      label: `mkdir ${directory}`,
      action: { type: 'mkdir', path: directory },
      expectation: { present: [{ name: directory, kind: DIRECTORY_KIND }], absent: [] },
    },
    {
      kind: 'create',
      label: `create ${created}`,
      action: {
        type: 'write',
        path: `${directory}/${created}`,
        contents: payload(64, `create-${suffix}`),
      },
      expectation: { present: [{ name: created, kind: FILE_KIND, size: 64 }], absent: [] },
    },
    {
      kind: 'modify',
      label: `rewrite ${created}`,
      action: {
        type: 'write',
        path: `${directory}/${created}`,
        contents: payload(512, `modify-${suffix}`),
      },
      expectation: { present: [{ name: created, kind: FILE_KIND, size: 512 }], absent: [] },
    },
    {
      kind: 'append',
      label: `append ${created}`,
      action: { type: 'append', path: `${directory}/${created}`, contents: 'y'.repeat(128) },
      expectation: { present: [{ name: created, kind: FILE_KIND, size: 640 }], absent: [] },
    },
    {
      kind: 'rename-file',
      label: `rename ${created} → ${renamed}`,
      action: {
        type: 'rename',
        from: `${directory}/${created}`,
        to: `${directory}/${renamed}`,
      },
      expectation: {
        present: [{ name: renamed, kind: FILE_KIND, size: 640 }],
        absent: [created],
      },
    },
    {
      kind: 'copy',
      label: `copy ${renamed} → ${copied}`,
      action: {
        type: 'copy',
        from: `${directory}/${renamed}`,
        to: `${directory}/${copied}`,
      },
      expectation: { present: [{ name: copied, kind: FILE_KIND, size: 640 }], absent: [] },
    },
    {
      kind: 'delete-file',
      label: `delete ${copied}`,
      action: { type: 'remove', path: `${directory}/${copied}`, recursive: false },
      expectation: { present: [], absent: [copied] },
    },
    {
      kind: 'mkdir-nested',
      label: `mkdir ${nestedDirectory}`,
      action: { type: 'mkdir', path: `${directory}/${nestedDirectory}` },
      expectation: {
        present: [{ name: nestedDirectory, kind: DIRECTORY_KIND }],
        absent: [],
      },
    },
    {
      kind: 'create-nested',
      label: `create ${nestedFile}`,
      action: {
        type: 'write',
        path: `${directory}/${nestedDirectory}/${nestedFile}`,
        contents: payload(256, `nested-${suffix}`),
      },
      expectation: { present: [{ name: nestedFile, kind: FILE_KIND, size: 256 }], absent: [] },
    },
    {
      kind: 'rename-directory',
      label: `rename ${nestedDirectory} → ${renamedNestedDirectory}`,
      action: {
        type: 'rename',
        from: `${directory}/${nestedDirectory}`,
        to: `${directory}/${renamedNestedDirectory}`,
      },
      expectation: {
        present: [
          { name: renamedNestedDirectory, kind: DIRECTORY_KIND },
          { name: nestedFile, kind: FILE_KIND, size: 256 },
        ],
        absent: [nestedDirectory],
      },
    },
    {
      kind: 'rename-directory-tree',
      label: `rename ${directory} → ${renamedDirectory}`,
      action: { type: 'rename', from: directory, to: renamedDirectory },
      expectation: {
        present: [
          { name: renamedDirectory, kind: DIRECTORY_KIND },
          { name: renamed, kind: FILE_KIND, size: 640 },
          { name: nestedFile, kind: FILE_KIND, size: 256 },
        ],
        absent: [directory],
      },
    },
    {
      kind: 'delete-directory-tree',
      label: `rm -rf ${renamedDirectory}`,
      action: { type: 'remove', path: renamedDirectory, recursive: true },
      expectation: {
        present: [],
        absent: [renamedDirectory, renamed, renamedNestedDirectory, nestedFile],
      },
    },
  ];
}

export function buildOperationPlan(total) {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(`operations must be a positive integer, got ${total}`);
  }
  const operations = [];
  let cycle = 1;
  while (operations.length < total) {
    for (const operation of cycleOperations(cycle)) {
      if (operations.length >= total) break;
      operations.push({ ...operation, id: operations.length + 1 });
    }
    cycle += 1;
  }
  return operations;
}

export async function executeOperation(root, operation) {
  const action = operation.action;
  switch (action.type) {
    case 'mkdir':
      await mkdir(safePath(root, action.path));
      return;
    case 'write':
      await writeFile(safePath(root, action.path), action.contents);
      return;
    case 'append':
      await appendFile(safePath(root, action.path), action.contents);
      return;
    case 'copy':
      await copyFile(safePath(root, action.from), safePath(root, action.to));
      return;
    case 'rename':
      await rename(safePath(root, action.from), safePath(root, action.to));
      return;
    case 'remove':
      await rm(safePath(root, action.path), {
        recursive: action.recursive,
        force: false,
      });
      return;
    default:
      throw new Error(`unsupported benchmark action: ${String(action.type)}`);
  }
}

export async function seedReferenceTree(root, totalFiles, { filesPerDirectory = 100 } = {}) {
  if (!Number.isSafeInteger(totalFiles) || totalFiles < 0) {
    throw new Error(`totalFiles must be a non-negative integer, got ${totalFiles}`);
  }
  if (!Number.isSafeInteger(filesPerDirectory) || filesPerDirectory < 1) {
    throw new Error(`filesPerDirectory must be a positive integer, got ${filesPerDirectory}`);
  }

  let created = 0;
  let directories = 0;
  while (created < totalFiles) {
    const directory = `reference-${String(directories + 1).padStart(4, '0')}`;
    await mkdir(safePath(root, directory));
    directories += 1;
    const count = Math.min(filesPerDirectory, totalFiles - created);
    await Promise.all(
      Array.from({ length: count }, (_, index) => {
        const fileNumber = created + index + 1;
        const name = `reference-${String(fileNumber).padStart(6, '0')}.txt`;
        return writeFile(safePath(root, `${directory}/${name}`), `reference ${fileNumber}\n`);
      }),
    );
    created += count;
  }

  return Object.freeze({ files: created, directories, entries: created + directories });
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

export function summarizeLatencies(values) {
  if (values.length === 0) {
    return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    min: sorted[0],
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

export function parseBuildIdentity(value) {
  if (!value) return null;
  try {
    const identity = JSON.parse(value);
    if (
      !identity ||
      typeof identity !== 'object' ||
      typeof identity.packageVersion !== 'string' ||
      typeof identity.nativeVersion !== 'string' ||
      typeof identity.resolvedPath !== 'string'
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}
