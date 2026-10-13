/**
 * The directory-install dialog: install a plugin the profile owns as a
 * directory (a source tree on this host, or one the browser picked and sends)
 * or as a startup row for an npm package that is already a dependency. Bundle
 * packages are not here — the Plugins page's own install dialog covers every
 * spec form `pnpm add` takes, and two dialogs for one action would disagree.
 * @module @deepseek-ai/dsh-client-ui-plugin-manager/InstallDirectoryDialog
 */

import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryInstallSpec, PluginDirectoryFile } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstallDirectoryInjected } from './install-directory.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import css from './InstallDirectoryDialog.module.css'

/**
 * The install forms this dialog owns; bundle specs go through the page's own
 * dialog. A client bundle may not import a Host package's values, so the form
 * union is restated as complete records: a missing or foreign id is a compile
 * error rather than a blank label.
 */
type DirectoryForm = 'file-dir' | 'upload-directory' | 'npm-register'

const FORMS: readonly DirectoryForm[] = ['file-dir', 'upload-directory', 'npm-register']

const FORM_LABEL = {
  'file-dir': 'installDirectoryFormFileDir',
  'upload-directory': 'installDirectoryFormUploadDirectory',
  'npm-register': 'installDirectoryFormNpmRegister',
} satisfies Record<DirectoryForm, PluginManagerLocaleKey>

const FORM_HINT = {
  'file-dir': 'installDirectoryHintFileDir',
  'upload-directory': 'installDirectoryHintUploadDirectory',
  'npm-register': 'installDirectoryHintNpmRegister',
} satisfies Record<DirectoryForm, PluginManagerLocaleKey>

/** What one attempt is showing. */
type Attempt =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly restartRequired: boolean }
  | { readonly status: 'failed'; readonly message: string }

/** Props: the shared store and Remote verbs, the plugin dictionary, and the locale seat. */
export type InstallDirectoryDialogProps = InjectFace<InstallDirectoryInjected> & PropsLocale<'pluginManager'>

/** Read one picked file as its base64 payload. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('failed to read the picked file')) }
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      resolve(text.slice(text.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** The failure text for a rejected call, preferring the Host's own diagnostic. */
function failureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

/**
 * Render the directory-install dialog.
 * @param props - the store, the two Remote verbs, and the locale seat.
 * @returns the modal, open while the shared store says so.
 */
export function InstallDirectoryDialog({
  t, useInstallDirectory, installPlugin, uninstallPlugin, closeDialog,
}: InstallDirectoryDialogProps): ReactNode {
  const open = useInstallDirectory(state => state.open)
  const [form, setForm] = useState<DirectoryForm>('file-dir')
  const [id, setId] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [packageName, setPackageName] = useState('')
  const [configJson, setConfigJson] = useState('')
  const [files, setFiles] = useState<readonly PluginDirectoryFile[]>([])
  const [removalId, setRemovalId] = useState('')
  const [attempt, setAttempt] = useState<Attempt>({ status: 'idle' })

  const busy = attempt.status === 'running'
  const includesFiles = form === 'upload-directory'
  const ready = id.trim() !== ''
    && (form === 'file-dir' ? sourcePath.trim() !== ''
      : form === 'npm-register' ? packageName.trim() !== ''
        : files.length > 0)

  const reset = (): void => {
    setId(''); setSourcePath(''); setPackageName(''); setConfigJson(''); setFiles([])
    setAttempt({ status: 'idle' })
  }

  /** Run one call and fold its outcome into the dialog's own state. */
  const run = async (action: () => Promise<{ application: string }>): Promise<void> => {
    setAttempt({ status: 'running' })
    try {
      const result = await action()
      setAttempt({ status: 'done', restartRequired: result.application === 'restart-required' })
    } catch (error) {
      setAttempt({ status: 'failed', message: failureText(error, t('installDirectoryFailed')) })
    }
  }

  const spec = (): DirectoryInstallSpec => form === 'file-dir'
    ? { form, id: id.trim(), sourcePath: sourcePath.trim() }
    : form === 'npm-register'
      ? { form, id: id.trim(), packageName: packageName.trim(), configJson: configJson.trim() }
      : { form, id: id.trim(), files }

  /** Read the browser-picked directory into base64-carrying entries. */
  const pickDirectory = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = [...event.target.files ?? []]
    // Reset so re-picking the same directory fires change again.
    event.target.value = ''
    setFiles(await Promise.all(picked.map(async file => ({
      path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
      content: await readAsBase64(file),
    }))))
  }

  return (
    <Modal
      open={open}
      title={t('installDirectoryTitle')}
      closeLabel={t('close')}
      onClose={() => { reset(); closeDialog() }}
      className={css.dialog as string}
    >
      <div className={css.forms} role="group" aria-label={t('installDirectoryTitle')}>
        {FORMS.map(candidate => (
          <button
            key={candidate}
            type="button"
            className={form === candidate ? `${css.chip} ${css.chipActive}` : css.chip}
            aria-pressed={form === candidate}
            disabled={busy}
            onClick={() => { setForm(candidate); setAttempt({ status: 'idle' }) }}
          >
            {t(FORM_LABEL[candidate])}
          </button>
        ))}
      </div>

      <p className={css.hint}>{t(FORM_HINT[form])}</p>

      <label className={css.field}>
        <span>{t('installDirectoryPluginId')}</span>
        <input value={id} disabled={busy} onChange={(event) => { setId(event.target.value) }} />
      </label>

      {form === 'file-dir' && (
        <label className={css.field}>
          <span>{t('installDirectorySourcePath')}</span>
          <input value={sourcePath} disabled={busy} onChange={(event) => { setSourcePath(event.target.value) }} />
        </label>
      )}

      {includesFiles && (
        <label className={css.field}>
          <span>{t('installDirectoryPickDirectory')}</span>
          <input type="file" multiple disabled={busy} {...{ webkitdirectory: '' }} onChange={(event) => { void pickDirectory(event) }} />
          <span className={css.count}>{t('installDirectoryPickedFiles', { count: String(files.length) })}</span>
        </label>
      )}

      {form === 'npm-register' && (
        <>
          <label className={css.field}>
            <span>{t('installDirectoryPackageName')}</span>
            <input value={packageName} disabled={busy} onChange={(event) => { setPackageName(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span>{t('installDirectoryConfigJson')}</span>
            <input value={configJson} disabled={busy} onChange={(event) => { setConfigJson(event.target.value) }} />
          </label>
        </>
      )}

      <div className={css.actions}>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => { void run(() => installPlugin(spec())) }}
        >
          {busy ? t('installDirectoryInstalling') : t('installDirectoryInstall')}
        </Button>
      </div>

      {attempt.status === 'done' && (
        <p className={css.success} role="status">
          {attempt.restartRequired ? t('restartNotice') : t('installDirectoryInstalled')}
        </p>
      )}
      {attempt.status === 'failed' && <p className={css.failure} role="alert">{attempt.message}</p>}

      <form
        className={css.remove}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (removalId.trim() === '') return
          void run(() => uninstallPlugin(removalId.trim()))
        }}
      >
        <label className={css.field}>
          <span>{t('installDirectoryRemoveLabel')}</span>
          <input value={removalId} disabled={busy} onChange={(event) => { setRemovalId(event.target.value) }} />
        </label>
        <Button type="submit" disabled={busy || removalId.trim() === ''}>{t('installDirectoryRemove')}</Button>
      </form>
    </Modal>
  )
}
