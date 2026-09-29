// @vitest-environment jsdom
/**
 * Message Center row behavior: the team-shell marker in the document head
 * gates rendering (absent marker = the row contributes nothing), the copy
 * comes from the locale dictionaries, and a click opens the account service's
 * `/inbox` page in a new tab so the current conversation survives.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageCenterRow, type MessageCenterRowProps } from '../src/client/MessageCenterRow.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.head.querySelector('meta[name="team-shell"]')?.remove()
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
  const t = ((key: string): string => dict[key as keyof typeof dict] ?? key) as MessageCenterRowProps['t']
  const props = { t } as MessageCenterRowProps
  return render(<MessageCenterRow {...props} />)
}

describe('MessageCenterRow', () => {
  it('renders the localized row when the document carries the team-shell marker', () => {
    setTeamShellMeta(true)
    mount('en')
    expect(screen.getByText(en.messageCenterTitle)).toBeTruthy()
    expect(screen.getByText(en.messageCenterHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Message Center/ })).toBeTruthy()
  })

  it('renders nothing when the team-shell marker is absent', () => {
    setTeamShellMeta(false)
    const view = mount('zh')
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens /inbox in a new tab when clicked', () => {
    setTeamShellMeta(true)
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)

    mount('zh')
    fireEvent.click(screen.getByRole('button', { name: /消息中心/ }))

    expect(openMock).toHaveBeenCalledWith('/inbox', '_blank', 'noopener')
  })
})
