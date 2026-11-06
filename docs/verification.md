# Single-step spotlight verification

## Box checks

- Server and client TypeScript checks: passed.
- Client build: passed.
- Regression suite: **153/153 passed**, zero failures. This includes the preserved 76-test core, 58 production-feature tests, 9 UI/glossary tests, and 10 stage-player tests.
- Isolated full-pipeline golden replay: **20/20 passed**, zero drifted.
- UI isolation: when Query Rewrite is selected, exactly one `[data-step-view]` exists; all eight other stage views are absent, not merely covered up.
- No old tabs, canvas, range sliders, permanent security/cache panels, or inspector grids are present in the active HTML.
- Playback tests cover minimum stage dwell, missing-stage ordering, indefinite pause, manual navigation, cache shortcuts, blocked security, buffered token typing, stream resets, and replay without a second request.
- Live isolated HTTP smoke checks: all nine status endpoints passed; actual SSE produced 189 events including 123 token deltas, traversed all nine stages, reused a repeat-answer cache hit, and stopped an adversarial request before generation.
- Accessible tooltip tests cover dynamic terms, keyboard focus, Escape, top-layer portal placement and the complete centralized inventory.

Regression generation, security/meaning fixtures and golden replay use explicit deterministic adapters. These checks do not establish live-model quality. Real-model weights were not downloaded or re-verified by this UI-only revision.

## Browser screenshot and deployment gate

A real-browser visual check is required before the Mac swap. The current executor has no browser/desktop subagent tool; the desktop skill prohibits Shell-driven browser automation. Therefore this revision does **not** claim PNG screenshots or a Mac deployment. A supervising agent with a browser subagent must capture and inspect:

1. `/workspace/shot-1-idle.png`: idle page, 1440 × 900.
2. `/workspace/shot-2-query-rewrite.png`: real request paused at Step 3, with every other stage absent.
3. `/workspace/shot-3-result.png`: completed result with the thin rail.

A dedicated isolated test server can run with:

```sh
MOCK_AI=true FORCE_MOCK_LLM=true FORCE_MOCK_GUARD=true FORCE_MOCK_NLI=true HOT_RELOAD=0 PORT=3502 npm start
```

Open `http://localhost:3502/` for idle. For a real request paused at Step 3, use `http://localhost:3502/?run=idp%20cert%20exp&pauseAt=query-rewrite`. Use a fresh runtime if that question was previously cached. For the result, run `How do I request a refund within 14 days?` and allow playback to settle.

After visual approval, copy the prepared archive to Patrick's Mac, extract once, restart the existing Node 20 listener once with `HOT_RELOAD=0`, check health/status endpoints without mutating defaults, and refresh matching Opera tabs once. Preserve the Mac environment, local weights and cache directory. No Mac changes have been made by this revision.
