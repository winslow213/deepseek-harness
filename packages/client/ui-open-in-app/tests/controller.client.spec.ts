/** Controller wire behavior: document-relative routes, availability filtering, and launch errors. */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
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
    expect(controller.currentApp()).toBeUndefined()
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

  it('requests the document-relative availability route', async () => {
    const fetcher = vi.fn(async (input: string | URL) => { void input; return jsonResponse({ apps: [] }) })
    const controller = new OpenInAppController(fetcher)
    await controller.load()
    expect(fetcher.mock.calls[0]?.[0]).toBe('open-in-app/apps')
  })
})

describe('OpenInAppController launching', () => {
  it('uses only nameable installed apps and falls back when the remembered choice is unavailable', () => {
    const controller = new OpenInAppController()
    controller.apps.set(['unknown-app', 'finder', 'cursor'])
    controller.choose('cursor')
    expect(controller.currentApp()).toBe('cursor')
    controller.apps.set(['unknown-app', 'finder'])
    expect(controller.currentApp()).toBe('finder')
    controller.apps.set(['unknown-app'])
    expect(controller.currentApp()).toBeUndefined()
  })

  it('shares the busy operation across gestures and captures its app and directory', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn((_input: string | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve }))
    const controller = new OpenInAppController(fetcher)
    controller.choose('cursor')
    const pending = controller.launch('cursor', '/workspace/first')
    expect(controller.operation.getSnapshot()).toEqual({ phase: 'busy', path: '/workspace/first' })
    controller.choose('finder')
    await controller.launch('finder', '/workspace/second')
    expect(controller.choice.getSnapshot()).toBe('cursor')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ app: 'cursor', path: '/workspace/first' }))
    finish(jsonResponse({ ok: true }))
    await pending
    expect(controller.operation.getSnapshot()).toEqual({ phase: 'idle', path: '/workspace/first' })
  })

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
    expect(fetcher.mock.calls[0]?.[0]).toBe('open-in-app/open')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: '/w/dir' }),
    })

    const failing = new OpenInAppController(async () => jsonResponse({}, 404))
    await expect(failing.launch('cursor', '/w/dir')).rejects.toThrow('open failed: HTTP 404')
    expect(failing.operation.getSnapshot()).toEqual({ phase: 'error', path: '/w/dir' })
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
      if (String(input).endsWith(OPEN_IN_APP_APPS_ROUTE)) return jsonResponse({ apps: ['vscode'], clientLaunch: true })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('vscode', '/w/dir')
    expect(navigate).toHaveBeenCalledWith('vscode://')
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith(OPEN_IN_APP_OPEN_ROUTE))).toBe(false)
  })

  it('keeps the host launch for apps without a URL scheme under a remote launch', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      if (String(input).endsWith(OPEN_IN_APP_APPS_ROUTE)) return jsonResponse({ apps: ['finder'], clientLaunch: true })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('finder', '/w/dir')
    expect(navigate).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith(OPEN_IN_APP_OPEN_ROUTE))).toBe(true)
  })

  it('keeps the host launch for editors when the host did not report a remote launch', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input
      if (String(input).endsWith(OPEN_IN_APP_APPS_ROUTE)) return jsonResponse({ apps: ['vscode'] })
      return jsonResponse({ ok: true })
    })
    const controller = new OpenInAppController(fetcher, navigate)
    await controller.load()
    await controller.launch('vscode', '/w/dir')
    expect(navigate).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith(OPEN_IN_APP_OPEN_ROUTE))).toBe(true)
  })
})
