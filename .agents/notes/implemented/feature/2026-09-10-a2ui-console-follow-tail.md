# Agent Note: A2UI console follows the newest output

Status: implemented

English | [中文](2026-09-10-a2ui-console-follow-tail.zh.md)

## Problem

The A2UI popup's command-run and live-result panes render output into a fixed-height `<pre>` (`max-height: 220px; overflow: auto`). There was no scroll-follow logic anywhere in the client package, so as a streaming run grew past the visible window the newest output scrolled out of view and the pane sat pinned at the top — the model and the user had to scroll manually to see progress, and a long `hdc shell hilog` stream in particular was effectively unreadable.

## Decision

`packages/client/ui-a2ui-render/src/standalone.tsx` gains a `ConsoleBody` component that owns one follower per pane:

- A `useRef` "follow" flag starts `true`, and re-arms to `true` whenever the `runKey` changes (a new command run, or a fresh live stream).
- A `useEffect` on `text` pins `scrollTop` to `scrollHeight` while following.
- `onScroll` detaches the follower when the user scrolls up (more than 24px from the bottom) and re-attaches when they return to the bottom — the standard terminal-follow interaction.

The two `<pre className={css.consoleBody}>` sites are replaced with `ConsoleBody`: the run pane keys off `run.runId`, the live pane off the constant `"live"` (the pane only renders while `live.active`).

## Alternatives considered

### Why not a one-line `scrollTop = scrollHeight` on every render?

That would fight the user: any attempt to scroll up and read earlier output would be immediately snapped back to the bottom. The follow/detach flag is what makes the behavior usable.

### Why not use an external auto-scroll library?

The behavior is a dozen lines and the package already imports `useRef`/`useEffect`; pulling a dependency for a single effect adds nothing the hand-rolled version does not already give.

### Why not add a "jump to bottom" button instead?

That is a reasonable future addition but does not replace following; the model and user want progress visible without interaction during a streaming run.

## Consequences

- Streaming run and live-result output now stay pinned to the newest line while following; scrolling up detaches, returning to the bottom (or a new run) re-attaches.
- No new dependency; the change is local to the standalone renderer.
- The change is client-side only and ships through the web bundle build.
