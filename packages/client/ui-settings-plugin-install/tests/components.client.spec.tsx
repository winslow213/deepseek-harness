// @vitest-environment jsdom
/** Plugin-install tab behavior over a scripted install face. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginInstallResult, PluginInstallSpec } from '@deepseek-ai/dsh-api-remotes/client'
import {
  PluginInstallSettingsTab,
  type PluginInstallSettingsTabProps,
} from '../src/client/PluginInstallSettingsTab.tsx'
import { en, type PluginInstallLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const FILE_DIR_RESULT: PluginInstallResult = {
  form: 'file-dir',
  profileDir: '/tmp/profile',
  pluginId: 'my-plugin',
}

const NPM_BUNDLE_RESULT: PluginInstallResult = {
  form: 'npm-bundle',
  profileDir: '/tmp/profile',
  bundlesAdded: ['@scope/pkg'],
}

const UPLOAD_RESULT: PluginInstallResult = {
  form: 'upload-directory',
  profileDir: '/tmp/profile',
  pluginId: 'region-router',
}

const REGISTER_RESULT: PluginInstallResult = {
  form: 'npm-register',
  profileDir: '/tmp/profile',
  pluginId: 'demo',
}

function mount(installPlugin: (spec: PluginInstallSpec) => Promise<PluginInstallResult>) {
  const t = (key: PluginInstallLocaleKey, params?: Record<string, string | number>): string => {
    const template = en[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
  }
  const props = {
    t,
    installPlugin,
  } as PluginInstallSettingsTabProps
  return render(<PluginInstallSettingsTab {...props} />)
}

/** A promise the spec resolves manually to hold the tab in its running state. */
function deferred() {
  let resolve!: (value: PluginInstallResult) => void
  const promise = new Promise<PluginInstallResult>((r) => { resolve = r })
  return { promise, resolve }
}

describe('PluginInstallSettingsTab', () => {
  it('opens on the file-dir form with the submit disabled until required fields are filled', () => {
    mount(vi.fn())

    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(screen.getByText(en.formFileDir)).toBeTruthy()
    expect(screen.getByText(en.formNpmBundle)).toBeTruthy()
    expect(screen.getByPlaceholderText(en.idPlaceholder)).toBeTruthy()
    expect(screen.getByPlaceholderText(en.sourcePathPlaceholder)).toBeTruthy()
    expect(screen.queryByPlaceholderText(en.npmSpecPlaceholder)).toBeNull()
    expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  })

  it('switches to the npm-bundle form, which swaps the fields it demands', () => {
    mount(vi.fn())

    fireEvent.click(screen.getByText(en.formNpmBundle))
    expect(screen.getByPlaceholderText(en.npmSpecPlaceholder)).toBeTruthy()
    expect(screen.queryByPlaceholderText(en.idPlaceholder)).toBeNull()
    expect(screen.queryByPlaceholderText(en.sourcePathPlaceholder)).toBeNull()
    expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  })

  it('switches to the npm-register form, which demands id and package name', () => {
    mount(vi.fn())

    fireEvent.click(screen.getByText(en.formNpmRegister))
    expect(screen.getByPlaceholderText(en.packageNamePlaceholder)).toBeTruthy()
    expect(screen.getByPlaceholderText(en.configJsonPlaceholder)).toBeTruthy()
    expect(screen.getByPlaceholderText(en.idPlaceholder)).toBeTruthy()
    expect(screen.queryByPlaceholderText(en.npmSpecPlaceholder)).toBeNull()
    expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  })

  it('submits a trimmed npm-register spec with its JSON config and reports the id', async () => {
    const install = vi.fn(() => Promise.resolve(REGISTER_RESULT))
    mount(install)

    fireEvent.click(screen.getByText(en.formNpmRegister))
    fireEvent.change(screen.getByPlaceholderText(en.idPlaceholder), { target: { value: '  demo  ' } })
    fireEvent.change(screen.getByPlaceholderText(en.packageNamePlaceholder), {
      target: { value: ' dsh-demo-plugin ' },
    })
    fireEvent.change(screen.getByPlaceholderText(en.configJsonPlaceholder), {
      target: { value: ' { "region": "cn-east" } ' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({
        form: 'npm-register',
        id: 'demo',
        packageName: 'dsh-demo-plugin',
        configJson: '{ "region": "cn-east" }',
      })
      expect(screen.getByText(en.successTitle)).toBeTruthy()
    })
    expect(screen.getByText('demo')).toBeTruthy()
  })

  it('switches to the upload-directory form, which shows the directory picker', () => {
    mount(vi.fn())

    fireEvent.click(screen.getByText(en.formUploadDirectory))
    expect(screen.getByPlaceholderText(en.idPlaceholder)).toBeTruthy()
    expect(screen.getByLabelText(/Plugin directory/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(en.sourcePathPlaceholder)).toBeNull()
    expect(screen.queryByPlaceholderText(en.npmSpecPlaceholder)).toBeNull()
    expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  })

  it('reads a picked directory into upload entries and submits them base64-encoded', async () => {
    const install = vi.fn((_spec: PluginInstallSpec) => Promise.resolve(UPLOAD_RESULT))
    mount(install)

    fireEvent.click(screen.getByText(en.formUploadDirectory))
    const picker = screen.getByLabelText(/Plugin directory/) as HTMLInputElement
    const router = new File(['export const route = "/r1"\n'], 'router.ts', { type: 'text/typescript' })
    Object.defineProperty(router, 'webkitRelativePath', { value: 'region-router/src/router.ts' })
    const index = new File(['export * from "./src/router.ts"\n'], 'index.ts', { type: 'text/typescript' })
    Object.defineProperty(index, 'webkitRelativePath', { value: 'region-router/index.ts' })
    fireEvent.change(picker, { target: { files: [router, index] } })

    await waitFor(() => { expect(screen.getByText('2 files selected')).toBeTruthy() })

    fireEvent.change(screen.getByPlaceholderText(en.idPlaceholder), { target: { value: 'region-router' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    await waitFor(() => {
      expect(install).toHaveBeenCalledTimes(1)
      expect(screen.getByText(en.successTitle)).toBeTruthy()
    })
    const spec = install.mock.calls[0]![0]
    expect(spec).toMatchObject({
      form: 'upload-directory',
      id: 'region-router',
      files: [
        { path: 'region-router/src/router.ts' },
        { path: 'region-router/index.ts' },
      ],
    })
    if (spec.form === 'upload-directory') {
      expect(atob(spec.files[0]!.content)).toBe('export const route = "/r1"\n')
      expect(atob(spec.files[1]!.content)).toBe('export * from "./src/router.ts"\n')
    }
  })

  it('submits a trimmed file-dir spec and reports the installed profile facts', async () => {
    const install = vi.fn(() => Promise.resolve(FILE_DIR_RESULT))
    mount(install)

    fireEvent.change(screen.getByPlaceholderText(en.idPlaceholder), { target: { value: '  my-plugin  ' } })
    fireEvent.change(screen.getByPlaceholderText(en.sourcePathPlaceholder), { target: { value: ' /tmp/plugin ' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ form: 'file-dir', id: 'my-plugin', sourcePath: '/tmp/plugin' })
      expect(screen.getByText(en.successTitle)).toBeTruthy()
    })
    expect(screen.getByText('/tmp/profile')).toBeTruthy()
    expect(screen.getByText('my-plugin')).toBeTruthy()
    expect(screen.getByText(en.restartNote)).toBeTruthy()
  })

  it('submits a trimmed npm spec and reports the promoted bundles', async () => {
    const install = vi.fn(() => Promise.resolve(NPM_BUNDLE_RESULT))
    mount(install)

    fireEvent.click(screen.getByText(en.formNpmBundle))
    fireEvent.change(screen.getByPlaceholderText(en.npmSpecPlaceholder), { target: { value: '  @scope/pkg@^1.2.0  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ form: 'npm-bundle', spec: '@scope/pkg@^1.2.0' })
      expect(screen.getByText(en.successTitle)).toBeTruthy()
    })
    expect(screen.getByText('@scope/pkg')).toBeTruthy()
  })

  it('blocks a second submit while the first install is still running', async () => {
    const { promise, resolve } = deferred()
    const install = vi.fn(() => promise)
    mount(install)

    fireEvent.change(screen.getByPlaceholderText(en.idPlaceholder), { target: { value: 'my-plugin' } })
    fireEvent.change(screen.getByPlaceholderText(en.sourcePathPlaceholder), { target: { value: '/tmp/plugin' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    expect(screen.getByRole('button', { name: en.installing })).toHaveProperty('disabled', true)
    fireEvent.submit(screen.getByRole('button', { name: en.installing }).closest('form')!)
    expect(install).toHaveBeenCalledTimes(1)

    resolve(FILE_DIR_RESULT)
    await waitFor(() => { expect(screen.getByText(en.successTitle)).toBeTruthy() })
  })

  it('surfaces the Remote failure message and code', async () => {
    const failure = (): Promise<PluginInstallResult> => {
      const error = new Error('source path is not absolute') as Error & { code?: string }
      error.code = 'plugin-install/invalid-spec'
      return Promise.reject(error)
    }
    mount(failure)

    fireEvent.change(screen.getByPlaceholderText(en.idPlaceholder), { target: { value: 'my-plugin' } })
    fireEvent.change(screen.getByPlaceholderText(en.sourcePathPlaceholder), { target: { value: 'relative' } })
    fireEvent.click(screen.getByRole('button', { name: en.install }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(en.errorTitle)
    expect(alert.textContent).toContain('source path is not absolute')
    expect(alert.textContent).toContain('plugin-install/invalid-spec')
  })
})
