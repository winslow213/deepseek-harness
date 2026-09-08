// @vitest-environment jsdom
/**
 * Standalone popup host: renders a page on `a2ui/init`, posts submissions/actions
 * back to the opener, and projects command-run progress into the console pane.
 */

import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { A2uiFormPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { renderA2uiPopup } from '../src/standalone.tsx'

/** The page the popup renders in these tests. */
function page(): A2uiFormPage {
  return {
    kind: 'form',
    title: 'Console Demo',
    fields: [{ name: 'note', label: 'Note', type: 'text' }],
    actions: [{ id: 'go', label: 'Run', execution: 'command', command: 'echo {note}' }],
  }
}

/** Install a fake opener window and a fresh mount root; returns a postMessage spy and the root. */
function harness(): { sent: Array<{ type: string }>; root: HTMLDivElement; opener: Window } {
  const sent: Array<{ type: string }> = []
  const opener = { postMessage: (message: { type: string }) => { sent.push(message) } } as unknown as Window
  Object.defineProperty(window, 'opener', { value: opener, configurable: true })
  const root = document.createElement('div')
  document.body.appendChild(root)
  return { sent, root, opener }
}

/** Send one opener→popup message from the fake opener window. */
function sendFromOpener(message: { type: string }, opener: Window): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: opener,
      data: message,
    }))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  // @ts-expect-error resetting the opener seam
  delete window.opener
})

describe('renderA2uiPopup', () => {
  it('renders the page once init arrives', () => {
    const { root, opener } = harness()
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: page() }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: page() }, opener)
    expect(root.querySelector('h3')?.textContent).toBe('Console Demo')
    expect(root.querySelector('input[name="note"]')).toBeTruthy()
  })

  it('posts a command action as a2ui/run and shows the console output as chunks arrive', () => {
    const { sent, root, opener } = harness()
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: page() }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: page() }, opener)

    // Click the command action button (routes through chrome → host onAction).
    const run = root.querySelector('button')!
    act(() => { run.click() })
    expect(sent).toContainEqual({
      type: 'a2ui/run',
      surfaceId: 's1',
      action: page().actions![0],
      values: { note: '' },
    })

    // Opener starts the run, pushes a chunk, and settles.
    sendFromOpener({ type: 'a2ui/runStarted', runId: 'r1', ok: true }, opener)
    sendFromOpener({ type: 'a2ui/runChunk', runId: 'r1', output: 'line1\n', running: true }, opener)
    sendFromOpener({ type: 'a2ui/runChunk', runId: 'r1', output: 'line2\n', running: false }, opener)
    sendFromOpener({ type: 'a2ui/runDone', runId: 'r1', exitCode: 0 }, opener)

    const pane = root.querySelector('[data-a2ui-console]')!
    expect(pane.textContent).toContain('line1')
    expect(pane.textContent).toContain('line2')
  })

  it('surfaces a run failure and drops the runStarted-expected state', () => {
    const { root, opener } = harness()
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: page() }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: page() }, opener)
    sendFromOpener({ type: 'a2ui/runFailed', message: 'no shell mounted', ok: false }, opener)

    const pane = root.querySelector('[data-a2ui-console]')!
    expect(pane.textContent).toContain('no shell mounted')
  })
})
