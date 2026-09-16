// @vitest-environment jsdom
/**
 * Keep-instance-running row behavior: the team-shell marker gates rendering,
 * the row reads the current `idleExempt` flag from `/api/me` on mount, and
 * flipping the switch posts the new value to `/api/me/idle-exempt`.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdleExemptRow, type IdleExemptRowProps } from '../src/client/IdleExemptRow.tsx'
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

function makeT(locale: 'en' | 'zh') {
  const dict = locale === 'en' ? en : zh
  return ((key: string) => dict[key as keyof typeof dict] ?? key) as IdleExemptRowProps['t']
}

function mount(locale: 'en' | 'zh' = 'zh') {
  const props = { t: makeT(locale) } as IdleExemptRowProps
  return render(<IdleExemptRow {...props} />)
}

describe('IdleExemptRow', () => {
  it('renders nothing when the team-shell marker is absent', () => {
    setTeamShellMeta(false)
    const view = mount('zh')
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('reads the current state from /api/me and reflects it on the switch', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({ authenticated: true, user: { idleExempt: true } }),
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)

    mount('en')
    expect(screen.getByText(en.idleExemptTitle)).toBeTruthy()
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/me') })
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true') })
  })

  it('posts the flipped value to /api/me/idle-exempt when toggled', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/me') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ authenticated: true, user: { idleExempt: false } }),
        } as unknown as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({ idleExempt: true }) } as unknown as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    mount('zh')
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })

    screen.getByRole('switch').click()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/me/idle-exempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exempt: true }),
      })
    })
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true') })
  })

  it('shows an error hint when the initial read fails', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)

    mount('zh')
    await waitFor(() => { expect(screen.getByText(zh.idleExemptError)).toBeTruthy() })
  })
})
