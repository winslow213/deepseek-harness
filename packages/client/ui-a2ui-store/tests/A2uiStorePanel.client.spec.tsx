// @vitest-environment jsdom
/** The saved-A2UI-tools panel: open/list, share (clipboard copy), import, and remove. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { A2uiToolWire } from '@deepseek-ai/dsh-api-remotes/client'
import { A2uiStorePanel, type A2uiStorePanelFace, type A2uiStorePanelProps } from '../src/client/A2uiStorePanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const TOOL: A2uiToolWire = {
  name: 'hilog-capture',
  page: { kind: 'form', title: 'Hilog capture', fields: [] },
  savedAt: '2026-09-10T00:00:00Z',
}

/** A `t` seat over the zh dictionary so assertions can read user-visible copy. */
const t = (key: string, params?: Record<string, string>): string => {
  const dict: Record<string, string> = {
    'entry.title': 'A2UI 工具',
    'panel.title': 'A2UI 工具',
    'panel.importPlaceholder': '粘贴分享令牌导入…',
    'panel.import': '导入',
    'panel.empty': '暂无已保存的工具',
    'panel.shared': '已复制 {name} 的分享令牌',
    'panel.importError': '导入失败，请检查令牌',
    'panel.shareError': '复制分享令牌失败，请重试',
    'panel.loadError': '加载失败，请重试',
    'panel.needSession': '请先打开一个会话',
    'panel.openError': '打开失败，请重试',
    'panel.close': '关闭',
    'row.remove': '删除',
    'row.share': '分享',
    'panel.loading': '加载中…',
  }
  const text = dict[key] ?? key
  if (params === undefined) return text
  return Object.entries(params).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, value), text)
}

/** Minimal session hook returning a fixed current session. */
function useSessions(sel: (s: { current: string | undefined }) => string | undefined): string | undefined {
  return sel({ current: 's1' })
}

function face(overrides: Partial<A2uiStorePanelFace> = {}): A2uiStorePanelFace {
  return {
    listTools: vi.fn(async () => ({ tools: [TOOL] })),
    openTool: vi.fn(async () => ({ surfaceId: 's' })),
    removeTool: vi.fn(async () => ({ removed: true })),
    shareTool: vi.fn(async () => ({ token: 'a2ui-share:abc' })),
    importTool: vi.fn(async () => ({ name: 'hilog-capture' })),
    ...overrides,
  }
}

function renderPanel(f: A2uiStorePanelFace, wide = false): void {
  render(<A2uiStorePanel {...panelProps(f, wide)} />)
}

/** Build the full prop object, stubbing the session/global seats the panel never reads. */
function panelProps(f: A2uiStorePanelFace, wide: boolean, sessions = useSessions): A2uiStorePanelProps {
  return {
    wide,
    useSessions: sessions,
    t,
    useSessionPendingInteraction: () => undefined,
    useWorkspaces: () => undefined,
    useResource: () => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} }),
    listTools: f.listTools,
    openTool: f.openTool,
    removeTool: f.removeTool,
    shareTool: f.shareTool,
    importTool: f.importTool,
  } as unknown as A2uiStorePanelProps
}

async function openPanel(f: A2uiStorePanelFace): Promise<void> {
  renderPanel(f)
  fireEvent.click(screen.getByRole('button', { name: 'A2UI 工具' }))
  await waitFor(() => { expect(screen.getByText('Hilog capture')).toBeTruthy() })
}

describe('A2uiStorePanel share', () => {
  it('copies the share token to the clipboard and confirms the copy', async () => {
    const f = face()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await waitFor(() => { expect(f.shareTool).toHaveBeenCalledWith('hilog-capture') })
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('a2ui-share:abc') })
    expect(screen.getByText('已复制 hilog-capture 的分享令牌')).toBeTruthy()
  })

  it('copies via the execCommand fallback when the Clipboard API is absent', async () => {
    const f = face()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    let copied = ''
    const exec = vi.fn(() => {
      copied = document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value ?? ''
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await waitFor(() => { expect(exec).toHaveBeenCalledWith('copy') })
    expect(copied).toBe('a2ui-share:abc')
    expect(screen.getByText('已复制 hilog-capture 的分享令牌')).toBeTruthy()
  })

  it('shows the share error when the clipboard refuses the write', async () => {
    const f = face()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await waitFor(() => { expect(screen.getByText('复制分享令牌失败，请重试')).toBeTruthy() })
  })

  it('shows the share error when the token cannot be produced', async () => {
    const f = face({ shareTool: vi.fn(async () => { throw new Error('not found') }) })
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await waitFor(() => { expect(screen.getByText('复制分享令牌失败，请重试')).toBeTruthy() })
  })
})

describe('A2uiStorePanel import', () => {
  it('imports a pasted token and reloads the list', async () => {
    const f = face()
    await openPanel(f)

    fireEvent.change(screen.getByPlaceholderText('粘贴分享令牌导入…'), { target: { value: 'a2ui-share:abc' } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => { expect(f.importTool).toHaveBeenCalledWith('a2ui-share:abc') })
    await waitFor(() => { expect(f.listTools).toHaveBeenCalledTimes(2) })
  })

  it('imports on Enter from the token input', async () => {
    const f = face()
    await openPanel(f)

    fireEvent.change(screen.getByPlaceholderText('粘贴分享令牌导入…'), { target: { value: 'a2ui-share:abc' } })
    fireEvent.keyDown(screen.getByPlaceholderText('粘贴分享令牌导入…'), { key: 'Enter' })
    await waitFor(() => { expect(f.importTool).toHaveBeenCalledWith('a2ui-share:abc') })
    // A non-Enter key is ignored.
    fireEvent.keyDown(screen.getByPlaceholderText('粘贴分享令牌导入…'), { key: 'a' })
    expect(f.importTool).toHaveBeenCalledTimes(1)
  })

  it('shows the import error when the token is rejected', async () => {
    const f = face({ importTool: vi.fn(async () => { throw new Error('invalid') }) })
    await openPanel(f)

    fireEvent.change(screen.getByPlaceholderText('粘贴分享令牌导入…'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    await waitFor(() => { expect(screen.getByText('导入失败，请检查令牌')).toBeTruthy() })
  })

  it('ignores an empty token and keeps the list intact', async () => {
    const f = face()
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    expect(f.importTool).not.toHaveBeenCalled()
    expect(screen.getByText('Hilog capture')).toBeTruthy()
  })
})

describe('A2uiStorePanel open/remove/load', () => {
  it('opens a tool into the current session', async () => {
    const f = face()
    const openWin = vi.fn()
    Object.defineProperty(window, 'open', { configurable: true, value: openWin })
    await openPanel(f)

    fireEvent.click(screen.getByText('Hilog capture'))
    await waitFor(() => { expect(f.openTool).toHaveBeenCalledWith('s1', 'hilog-capture') })
    await waitFor(() => { expect(openWin).toHaveBeenCalled() })
  })

  it('refuses to open without a current session', async () => {
    const f = face()
    const useSessionsNone = (sel: (s: { current: string | undefined }) => string | undefined): string | undefined =>
      sel({ current: undefined })
    render(<A2uiStorePanel {...panelProps(f, false, useSessionsNone)} />)
    fireEvent.click(screen.getByRole('button', { name: 'A2UI 工具' }))
    await waitFor(() => { expect(screen.getByText('Hilog capture')).toBeTruthy() })

    fireEvent.click(screen.getByText('Hilog capture'))
    await waitFor(() => { expect(screen.getByText('请先打开一个会话')).toBeTruthy() })
    expect(f.openTool).not.toHaveBeenCalled()
  })

  it('surfaces an open failure', async () => {
    const f = face({ openTool: vi.fn(async () => { throw new Error('boom') }) })
    await openPanel(f)

    fireEvent.click(screen.getByText('Hilog capture'))
    await waitFor(() => { expect(screen.getByText('打开失败，请重试')).toBeTruthy() })
  })

  it('removes a tool and leaves the list shorter', async () => {
    const f = face()
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(f.removeTool).toHaveBeenCalledWith('hilog-capture') })
    await waitFor(() => { expect(screen.queryByText('Hilog capture')).toBeNull() })
  })

  it('keeps the list when a remove fails', async () => {
    const f = face({ removeTool: vi.fn(async () => { throw new Error('boom') }) })
    await openPanel(f)

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(f.removeTool).toHaveBeenCalled() })
    expect(screen.getByText('Hilog capture')).toBeTruthy()
  })

  it('shows the load error when listing fails', async () => {
    const f = face({ listTools: vi.fn(async () => { throw new Error('boom') }) })
    renderPanel(f)
    fireEvent.click(screen.getByRole('button', { name: 'A2UI 工具' }))
    await waitFor(() => { expect(screen.getByText('加载失败，请重试')).toBeTruthy() })
  })

  it('shows the empty hint when no tools are saved', async () => {
    const f = face({ listTools: vi.fn(async () => ({ tools: [] })) })
    renderPanel(f)
    fireEvent.click(screen.getByRole('button', { name: 'A2UI 工具' }))
    await waitFor(() => { expect(screen.getByText('暂无已保存的工具')).toBeTruthy() })
  })

  it('shows the label when the entry is wide', () => {
    const f = face()
    render(<A2uiStorePanel {...panelProps(f, true)} />)
    expect(screen.getByRole('button', { name: 'A2UI 工具' })).toBeTruthy()
  })

  it('toggles the panel closed on a second entry click', async () => {
    const f = face()
    await openPanel(f)
    fireEvent.click(screen.getByRole('button', { name: 'A2UI 工具' }))
    await waitFor(() => { expect(screen.queryByText('Hilog capture')).toBeNull() })
  })

  it('closes the panel from its close button', async () => {
    const f = face()
    await openPanel(f)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => { expect(screen.queryByText('Hilog capture')).toBeNull() })
  })

  it('dismisses the panel on an outside pointerdown', async () => {
    const f = face()
    await openPanel(f)
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(screen.queryByText('Hilog capture')).toBeNull() })
  })
})
