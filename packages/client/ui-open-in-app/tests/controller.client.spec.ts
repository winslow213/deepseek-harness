/** Controller wire behavior: host-base resolution, availability filtering, and launch errors. */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { OpenInAppController } from '../src/client/controller.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('OpenInAppController availability', () => {
  it('starts without a platform-specific choice', () => {
    const controller = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    expect(controller.choice.getSnapshot()).toBe('')
  })

  it('shares one availability read across concurrent loads', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ apps: ['finder'] }))
    const controller = new OpenInAppController(fetcher)
    await Promise.all([controller.load(), controller.load()])
    await controller.load()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(controller.apps.getSnapshot()).toEqual(['finder'])
  })

  it('publishes an empty list for a non-OK availability answer and for a non-array payload', async () => {
    const failing = new OpenInAppController(async () => jsonResponse({}, 500))
    await failing.load()
    expect(failing.apps.getSnapshot()).toEqual([])

    const malformed = new OpenInAppController(async () => jsonResponse({ apps: 'nope' }))
    await malformed.load()
    expect(malformed.apps.getSnapshot()).toEqual([])
  })

  it('resolves routes against the page origin when the page has one', async () => {
    vi.stubGlobal('location', { origin: 'http://dsh.example:8080' })
    const fetcher = vi.fn(async (input: string | URL) => { void input; return jsonResponse({ apps: [] }) })
    const controller = new OpenInAppController(fetcher)
    await controller.load()
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://dsh.example:8080/open-in-app/apps')
  })

  it('falls back to the internal host base under a null origin', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const fetcher = vi.fn(async (input: string | URL) => { void input; return jsonResponse({ apps: [] }) })
    const controller = new OpenInAppController(fetcher)
    await controller.load()
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://dsh.internal/open-in-app/apps')
  })
})

describe('OpenInAppController launching', () => {
  it('restores the chosen app from the open-in-app storage key', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const controller = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    controller.choose('cursor')
    expect(controller.choice.getSnapshot()).toBe('cursor')
    expect(values.get('dsh.open-in-app.choice')).toBe('"cursor"')
    const reloaded = new OpenInAppController(async () => jsonResponse({ apps: [] }))
    expect(reloaded.choice.getSnapshot()).toBe('cursor')
  })

  it('posts the launch body and surfaces HTTP failures', async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => { void input; void init; return jsonResponse({ ok: true }) })
    const controller = new OpenInAppController(fetcher)
    await controller.launch('cursor', '/w/dir')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: '/w/dir' }),
    })

    const failing = new OpenInAppController(async () => jsonResponse({}, 404))
    await expect(failing.launch('cursor', '/w/dir')).rejects.toThrow('open failed: HTTP 404')
  })
})

describe('OpenInAppController client-side launching', () => {
  let navigate: Mock<(url: string) => void>

  beforeEach(() => {
    navigate = vi.fn<(url: string) => void>()
  })

  it('opens editor apps through their URL scheme when the host reports a remote launch', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      if (String(input).includes('/open-in-app/apps')) return jsonResponse({ apps: ['vscode'], clientLaunch: true })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('vscode', '/w/dir')
    expect(navigate).toHaveBeenCalledWith('vscode://')
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/open-in-app/open'))).toBe(false)
  })

  it('keeps the host launch for apps without a URL scheme under a remote launch', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      if (String(input).includes('/open-in-app/apps')) return jsonResponse({ apps: ['finder'], clientLaunch: true })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('finder', '/w/dir')
    expect(navigate).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/open-in-app/open'))).toBe(true)
  })

  it('keeps the host launch for editors when the host did not report a remote launch', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      if (String(input).includes('/open-in-app/apps')) return jsonResponse({ apps: ['vscode'] })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('vscode', '/w/dir')
    expect(navigate).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/open-in-app/open'))).toBe(true)
  })
})
