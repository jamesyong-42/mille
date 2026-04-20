// useFileTreeContext — named accessor for the tree context value.
// Throws a developer-friendly error when used outside a provider.

import { useContext } from 'react';
import { FileTreeContext, type FileTreeContextValue } from '../context.js';

export function useFileTreeContext(): FileTreeContextValue {
  const value = useContext(FileTreeContext);
  if (value === null) {
    throw new Error('useFileTreeContext must be called inside FileTreeProvider');
  }
  return value;
}
