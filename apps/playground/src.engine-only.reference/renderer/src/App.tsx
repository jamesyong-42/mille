import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import {
  connectFileExplorer,
  type PortFileExplorer,
} from '@vibecook/mille/port';
import type { PortMirrorSnapshot } from '@vibecook/mille/port';
import { fxPortReady } from './fx-port';

interface ConnectionState {
  fx: PortFileExplorer;
  workspaceRoot: string;
}

export function App(): ReactElement {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let fx: PortFileExplorer | null = null;

    (async () => {
      try {
        const { port, workspaceRoot } = await fxPortReady;
        fx = await connectFileExplorer(port, {
          mirrorCap: 20_000,
          prefetchRows: 200,
        });
        if (!disposed) setConn({ fx, workspaceRoot });
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      fx?.dispose();
    };
  }, []);

  if (error) return <pre className="error">connection failed: {error}</pre>;
  if (!conn) return <div className="loading">connecting to mille host…</div>;

  return <Explorer fx={conn.fx} root={conn.workspaceRoot} />;
}

function Explorer({ fx, root }: { fx: PortFileExplorer; root: string }): ReactElement {
  const snap = usePortSnapshot(fx);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const rootIds = snap.roots();
  const rows = snap.visibleRows({ offset: 0, limit: 2000, expanded });

  function toggle(id: number): void {
    const isOpen = expanded.has(id);
    const next = new Set(expanded);
    if (isOpen) next.delete(id);
    else next.add(id);
    setExpanded(next);
    fx.setExpanded(isOpen ? { remove: [id] } : { add: [id] });
  }

  return (
    <div className="app">
      <header>
        <h1>mille · playground</h1>
        <div className="meta">
          <span>root: {root}</span>
          <span>· roots: {rootIds.length}</span>
          <span>· rows: {rows.length}</span>
          <span>· version: {fx.getTreeVersion()}</span>
        </div>
      </header>
      <ul className="tree">
        {rows.map((row) => {
          const entry = snap.getById(row.id);
          const isDir = entry?.kind === 1;
          const isOpen = expanded.has(row.id);
          return (
            <li
              key={row.id}
              style={{ paddingLeft: `${row.depth * 16 + 8}px` }}
              className={isDir ? 'dir' : 'file'}
              onClick={() => isDir && toggle(row.id)}
            >
              <span className="chev">{isDir ? (isOpen ? '▾' : '▸') : ' '}</span>
              <span className="name">{entry?.name ?? `#${row.id}`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function usePortSnapshot(fx: PortFileExplorer): PortMirrorSnapshot {
  return useSyncExternalStore(
    (cb) => {
      const sub = fx.on('change', cb);
      return () => sub.dispose();
    },
    () => fx.getSnapshot(),
    () => fx.getSnapshot(),
  );
}
