// @vitest-environment jsdom
/**
 * Standalone popup host: renders a page on `a2ui/init`, posts submissions/actions
 * back to the opener, and projects command-run progress into the console pane.
 */

import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { A2uiFormPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { A2uiOpenerMessage } from '../src/a2ui-wire.ts'
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
function sendFromOpener(message: A2uiOpenerMessage, opener: Window): void {
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
  Object.defineProperty(window, 'opener', { value: null, configurable: true })
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

  it('renders the live-result pane from liveStarted/liveChunk/liveDone', () => {
    const { root, opener } = harness()
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: page() }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: page() }, opener)

    sendFromOpener({ type: 'a2ui/liveStarted', surfaceId: 's1' }, opener)
    sendFromOpener({ type: 'a2ui/liveChunk', surfaceId: 's1', output: 'log1\n' }, opener)
    sendFromOpener({ type: 'a2ui/liveChunk', surfaceId: 's1', output: 'log2\n' }, opener)
    sendFromOpener({ type: 'a2ui/liveDone', surfaceId: 's1' }, opener)

    const pane = root.querySelector('[data-a2ui-live]')!
    expect(pane.textContent).toContain('log1')
    expect(pane.textContent).toContain('log2')
  })

  it('fires optionsFrom actions on open and fills the select from their completion', () => {
    const { sent, root, opener } = harness()
    const dynamic: A2uiFormPage = {
      kind: 'form',
      title: 'Dynamic',
      fields: [
        { name: 'device', label: 'Device', type: 'select', optionsFrom: 'list' },
      ],
      actions: [{ id: 'list', label: 'List', execution: 'script', program: 'return []', binds: [] }],
    }
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: dynamic }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: dynamic }, opener)
    // The open triggers one auto runScript for the optionsFrom action.
    expect(sent.some(m => m.type === 'a2ui/runScript')).toBe(true)

    // The opener returns an options array for that action.
    sendFromOpener({
      type: 'a2ui/scriptResult', actionId: 'list', value: [{ label: 'SN-1', value: 'sn1' }, { label: 'SN-2', value: 'sn2' }], ok: true,
    }, opener)
    const select = root.querySelector('select[name="device"]') as HTMLSelectElement | null
    expect(select?.options.length ?? 0).toBe(2)
    expect(select?.options[0]?.text).toBe('SN-1')
  })

  it('requests a host-backed source on open and fills the select from the data reply', () => {
    const { sent, root, opener } = harness()
    const sourced: A2uiFormPage = {
      kind: 'form',
      title: 'Sourced',
      fields: [
        { name: 'device', label: 'Device', type: 'select', source: 'hdc-devices' },
      ],
    }
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: sourced }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: sourced }, opener)
    // The open triggers one data-request for the source.
    expect(sent.some(m => m.type === 'a2ui/data-request')).toBe(true)

    sendFromOpener({
      type: 'a2ui/data', surfaceId: 's1', source: 'hdc-devices',
      items: [{ label: 'SN-1', value: 'sn1' }, { label: 'SN-2', value: 'sn2' }],
    }, opener)
    const select = root.querySelector('select[name="device"]') as HTMLSelectElement | null
    expect(select?.options.length ?? 0).toBe(2)
    expect(select?.options[0]?.text).toBe('SN-1')
  })

  it('leaves a source-backed select empty when the source fails to resolve', () => {
    const { sent, root, opener } = harness()
    const sourced: A2uiFormPage = {
      kind: 'form',
      title: 'Sourced',
      fields: [
        { name: 'device', label: 'Device', type: 'select', source: 'hdc-devices' },
      ],
    }
    act(() => { renderA2uiPopup(root, { surfaceId: 's1', page: sourced }) })
    sendFromOpener({ type: 'a2ui/init', surfaceId: 's1', page: sourced }, opener)
    expect(sent.some(m => m.type === 'a2ui/data-request')).toBe(true)

    sendFromOpener({ type: 'a2ui/data-failed', surfaceId: 's1', source: 'hdc-devices', message: 'no devices' }, opener)
    const select = root.querySelector('select[name="device"]') as HTMLSelectElement | null
    expect(select?.options.length ?? 0).toBe(0)
  })
})
