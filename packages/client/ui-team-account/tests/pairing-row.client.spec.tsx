// @vitest-environment jsdom
/**
 * Pairing code row behavior: the team-shell marker gates rendering, clicking
 * mints a code through the same-origin `/api/pairings`, and the minted code
 * plus its claim command are shown with a copy control.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingRow, type PairingRowProps } from '../src/client/PairingRow.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head.querySelector('meta[name="team-shell"]')?.remove()
})

function setTeamShellMeta(present: boolean): void {
  document.head.querySelector('meta[name="team-shell"]')?.remove()
  if (!present) return
  const meta = document.createElement('meta')
  meta.name = 'team-shell'
  meta.content = '1'
  document.head.appendChild(meta)
}

/** A `t` that renders `{key}` placeholders from the params object. */
function makeT(locale: 'en' | 'zh') {
  const dict = locale === 'en' ? en : zh
  return ((key: string, params?: Record<string, string>) => {
    let text = dict[key as keyof typeof dict] ?? key
    if (params !== undefined) {
      for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, v)
    }
    return text
  }) as PairingRowProps['t']
}

function mount(locale: 'en' | 'zh' = 'zh') {
  const props = { t: makeT(locale) } as PairingRowProps
  return render(<PairingRow {...props} />)
}

describe('PairingRow', () => {
  it('renders the localized row when the document carries the team-shell marker', () => {
    setTeamShellMeta(true)
    mount('zh')
    expect(screen.getByText(zh.pairTitle)).toBeTruthy()
    expect(screen.getByText(zh.pairHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: /生成配对码/ })).toBeTruthy()
  })

  it('renders nothing when the team-shell marker is absent', () => {
    setTeamShellMeta(false)
    const view = mount('zh')
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('mints a code on click and shows the code + claim command', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ uuid: 'abc-123', user: 'alice', expiresAt: Date.now() + 1000, ttlMs: 1000 }),
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })

    mount('zh')
    fireEvent.click(screen.getByRole('button', { name: /生成配对码/ }))

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/pairings', { method: 'POST' }) })
    await waitFor(() => { expect(screen.getByText('abc-123')).toBeTruthy() })
    expect(screen.getByText(zh.pairCommandLabel)).toBeTruthy()
    // The claim command embeds the code.
    expect(screen.getByText(/--pair abc-123/)).toBeTruthy()
  })

  it('shows an error when minting fails', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, json: async () => ({ error: 'no session' }) } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)

    mount('zh')
    fireEvent.click(screen.getByRole('button', { name: /生成配对码/ }))

    await waitFor(() => { expect(screen.getByText(zh.pairError)).toBeTruthy() })
    await act(async () => {})
  })
})
