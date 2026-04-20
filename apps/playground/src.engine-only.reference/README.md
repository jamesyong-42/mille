# engine-only playground — reference snapshot

This directory is a verbatim snapshot of `apps/playground/src/` taken
**before Phase 15 rewrote the playground to demonstrate `@vibecook/mille-ui`**.

It preserves the minimal engine-only wiring: UtilityProcess fx host +
MessageChannelMain + preload port forwarder + a bare-bones renderer that
renders a flat tree directly from `PortFileExplorer.getSnapshot()`.

Kept for reference while the mille-ui playground stabilizes. If you need
to inspect the tiny hand-rolled renderer that existed before the
FileTreeProvider + FileTree wiring, look here.

Safe to delete once the playground has stabilized on mille-ui.
