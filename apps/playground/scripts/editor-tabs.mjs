export function planEditorTabOpen(tabs, entry, mode) {
  const tabId = `file:${entry.id}`;
  const existing = tabs.find((tab) => tab.id === tabId);
  if (existing !== undefined) {
    const next =
      mode === 'permanent' && existing.preview
        ? tabs.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab))
        : tabs;
    return {
      tabs: next,
      activeTabId: tabId,
      shouldLoad: false,
    };
  }

  let next = tabs.filter((tab) => tab.kind !== 'welcome');
  if (mode === 'preview') {
    next = next.filter((tab) => !tab.preview);
  }
  return {
    tabs: [
      ...next,
      {
        id: tabId,
        title: entry.name,
        kind: 'file',
        entryId: entry.id,
        body: '// loading…',
        highlighted: false,
        preview: mode === 'preview',
      },
    ],
    activeTabId: tabId,
    shouldLoad: true,
  };
}

export function settleEditorTabLoad(
  tabs,
  tabId,
  body,
  highlighted,
  requestRevision,
  currentRevision,
) {
  if (requestRevision !== currentRevision || !tabs.some((tab) => tab.id === tabId)) {
    return tabs;
  }
  return tabs.map((tab) => (tab.id === tabId ? { ...tab, body, highlighted } : tab));
}
