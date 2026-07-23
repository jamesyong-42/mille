export const NAVIGATION_STORE_VERSION: 1;
export const NAVIGATION_STORE_MAX_WORKSPACES: number;
export const NAVIGATION_STORE_MAX_STATE_BYTES: number;

export interface NavigationStateStore {
  get(root: string): string | null;
  set(root: string, state: string): boolean;
  entries(): Array<{
    readonly root: string;
    readonly updatedAt: number;
    readonly state: string;
  }>;
}

export function createNavigationStateStore(options: {
  readonly filePath: string;
  readonly maxWorkspaces?: number;
  readonly maxStateBytes?: number;
  readonly now?: () => number;
}): NavigationStateStore;
