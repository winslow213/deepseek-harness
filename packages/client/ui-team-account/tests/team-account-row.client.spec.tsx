// @vitest-environment jsdom
/**
 * Sign out row behavior: the team-shell marker in the document head gates
 * rendering (absent marker = the row contributes nothing), the copy comes
 * from the locale dictionaries, and a click posts to the same-origin
 * `/api/logout` and then navigates to `/`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamAccountRow, type TeamAccountRowProps } from '../src/client/TeamAccountRow.tsx'
import { en, zh } from '../src/client/locales.ts'

let originalLocation: Location | undefined
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head.querySelector('meta[name="team-shell"]')?.remove()
  if (originalLocation !== undefined) {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
    originalLocation = undefined
  }
})

/** Add or remove the marker the team reverse proxy injects into served HTML. */
function setTeamShellMeta(present: boolean): void {
  document.head.querySelector('meta[name="team-shell"]')?.remove()
  if (!present) return
  const meta = document.createElement('meta')
  meta.name = 'team-shell'
  meta.content = '1'
  document.head.appendChild(meta)
}

function mount(locale: 'en' | 'zh' = 'zh') {
  const dict = locale === 'en' ? en : zh
  const t = ((key: string): string => dict[key as keyof typeof dict] ?? key) as TeamAccountRowProps['t']
  const props = { t } as TeamAccountRowProps
  return render(<TeamAccountRow {...props} />)
}

describe('TeamAccountRow', () => {
  it('renders the localized row when the document carries the team-shell marker', () => {
    setTeamShellMeta(true)
    mount('en')
    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.getByText(en.hint)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeTruthy()
  })

  it('renders nothing when the team-shell marker is absent', () => {
    setTeamShellMeta(false)
    const view = mount('zh')
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('starts rendering as soon as the marker appears (the check runs per render)', () => {
    setTeamShellMeta(false)
    mount('zh')
    expect(screen.queryByRole('button', { name: /退出登录/ })).toBeNull()

    setTeamShellMeta(true)
    mount('zh')
    expect(screen.getByText(zh.title)).toBeTruthy()
    expect(screen.getByRole('button', { name: /退出登录/ })).toBeTruthy()
  })

  it('posts to /api/logout and navigates to / when clicked', async () => {
    setTeamShellMeta(true)
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)
    const hrefs: string[] = []
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        get href(): string { return 'http://localhost/' },
        set href(next: string) { hrefs.push(next) },
      },
    })

    mount('en')
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }))

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/logout', { method: 'POST' }) })
    await act(async () => {})
    expect(hrefs).toEqual(['/'])
  })
})
