import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import type {
  DirectoryUploadFile,
  PluginInstallForm,
  PluginInstallResult,
  PluginInstallSpec,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginInstallSettingsTab.module.css'

/** Registration-side Remote face consumed by the section. */
export interface PluginInstallSettingsTabInjected {
  /** Run one install request; resolves with the outcome or rejects with the Remote failure. */
  installPlugin: (spec: PluginInstallSpec) => Promise<PluginInstallResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginInstallSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInstall'>
  & InjectFace<PluginInstallSettingsTabInjected>

type ViewState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'success'; readonly result: PluginInstallResult }
  | { readonly status: 'error'; readonly message: string; readonly code: string | undefined }

function buildSpec(
  form: PluginInstallForm,
  id: string,
  sourcePath: string,
  npmSpec: string,
  files: readonly DirectoryUploadFile[],
): PluginInstallSpec {
  if (form === 'file-dir') return { form: 'file-dir', id: id.trim(), sourcePath: sourcePath.trim() }
  if (form === 'upload-directory') return { form: 'upload-directory', id: id.trim(), files }
  return { form: 'npm-bundle', spec: npmSpec.trim() }
}

/** Read one picked file as a base64 payload (the `data:...;base64,` prefix stripped). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('failed to read the picked file')) }
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : ''
      resolve(data.slice(data.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** Operator form to install an external plugin into the Web profile directory. */
export function PluginInstallSettingsTab({
  t,
  installPlugin,
}: PluginInstallSettingsTabProps): ReactNode {
  const [form, setForm] = useState<PluginInstallForm>('file-dir')
  const [id, setId] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [npmSpec, setNpmSpec] = useState('')
  const [files, setFiles] = useState<DirectoryUploadFile[]>([])
  const [state, setState] = useState<ViewState>({ status: 'idle' })

  const running = state.status === 'running'
  const ready = form === 'file-dir'
    ? id.trim() !== '' && sourcePath.trim() !== ''
    : form === 'upload-directory'
      ? id.trim() !== '' && files.length > 0
      : npmSpec.trim() !== ''

  const pickDirectory = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const picked = event.target.files
    if (picked === null) {
      setFiles([])
      return
    }
    const entries: DirectoryUploadFile[] = []
    for (const file of Array.from(picked)) {
      const path = file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
      entries.push({ path, content: await readAsBase64(file) })
    }
    // Reset the input so re-picking the same directory fires change again.
    event.target.value = ''
    setFiles(entries)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready || running) return
    setState({ status: 'running' })
    void installPlugin(buildSpec(form, id, sourcePath, npmSpec, files)).then(
      (result) => { setState({ status: 'success', result }) },
      (error: unknown) => {
        const code = error instanceof Error
          ? (error as { code?: unknown }).code
          : undefined
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          code: typeof code === 'string' ? code : undefined,
        })
      },
    )
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      <form className={css.form} aria-busy={running} onSubmit={submit}>
        <fieldset className={css.formKind} disabled={running}>
          <legend className={css.visuallyHidden}>{t('formKindLabel')}</legend>
          <label className={css.formOption}>
            <input
              type="radio"
              name="form"
              value="file-dir"
              checked={form === 'file-dir'}
              onChange={() => { setForm('file-dir') }}
            />
            <span>
              <strong>{t('formFileDir')}</strong>
              <small>{t('formFileDirHint')}</small>
            </span>
          </label>
          <label className={css.formOption}>
            <input
              type="radio"
              name="form"
              value="npm-bundle"
              checked={form === 'npm-bundle'}
              onChange={() => { setForm('npm-bundle') }}
            />
            <span>
              <strong>{t('formNpmBundle')}</strong>
              <small>{t('formNpmBundleHint')}</small>
            </span>
          </label>
          <label className={css.formOption}>
            <input
              type="radio"
              name="form"
              value="upload-directory"
              checked={form === 'upload-directory'}
              onChange={() => { setForm('upload-directory') }}
            />
            <span>
              <strong>{t('formUploadDirectory')}</strong>
              <small>{t('formUploadDirectoryHint')}</small>
            </span>
          </label>
        </fieldset>
        {form === 'file-dir' ? (
          <div className={css.fields} key={form}>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('idLabel')}
                <em className={css.required}>{t('required')}</em>
              </span>
              <input
                value={id}
                onChange={(event) => { setId(event.target.value) }}
                placeholder={t('idPlaceholder')}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
              />
              <small className={css.fieldHint}>{t('idDescription')}</small>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('sourcePathLabel')}
                <em className={css.required}>{t('required')}</em>
              </span>
              <input
                value={sourcePath}
                onChange={(event) => { setSourcePath(event.target.value) }}
                placeholder={t('sourcePathPlaceholder')}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
              />
              <small className={css.fieldHint}>{t('sourcePathDescription')}</small>
            </label>
          </div>
        ) : form === 'upload-directory' ? (
          <div className={css.fields} key={form}>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('idLabel')}
                <em className={css.required}>{t('required')}</em>
              </span>
              <input
                value={id}
                onChange={(event) => { setId(event.target.value) }}
                placeholder={t('idPlaceholder')}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
              />
              <small className={css.fieldHint}>{t('idDescription')}</small>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('directoryLabel')}</span>
              <input
                type="file"
                {...{ webkitdirectory: '' }}
                onChange={(event) => { void pickDirectory(event) }}
                disabled={running}
              />
              <small className={css.fieldHint}>{t('directoryDescription')}</small>
              {files.length > 0 ? (
                <small className={css.fileCount}>{t('filesSelected', { count: files.length })}</small>
              ) : null}
            </label>
          </div>
        ) : (
          <div className={css.fields} key={form}>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('npmSpecLabel')}
                <em className={css.required}>{t('required')}</em>
              </span>
              <input
                value={npmSpec}
                onChange={(event) => { setNpmSpec(event.target.value) }}
                placeholder={t('npmSpecPlaceholder')}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
              />
              <small className={css.fieldHint}>{t('npmSpecDescription')}</small>
            </label>
          </div>
        )}
        <button type="submit" className={css.submit} disabled={!ready || running}>
          {running ? t('installing') : t('install')}
        </button>
      </form>
      {state.status === 'success' ? (
        <div className={css.result} aria-live="polite">
          <h3 className={css.resultTitle}>{t('successTitle')}</h3>
          <dl className={css.facts}>
            <div>
              <dt>{t('profileDirLabel')}</dt>
              <dd><code>{state.result.profileDir}</code></dd>
            </div>
            {state.result.pluginId !== undefined ? (
              <div>
                <dt>{t('pluginIdLabel')}</dt>
                <dd><code>{state.result.pluginId}</code></dd>
              </div>
            ) : null}
            {state.result.bundlesAdded !== undefined && state.result.bundlesAdded.length > 0 ? (
              <div>
                <dt>{t('bundlesAddedLabel')}</dt>
                <dd><code>{state.result.bundlesAdded.join(', ')}</code></dd>
              </div>
            ) : null}
          </dl>
          <p className={css.restartNote}>{t('restartNote')}</p>
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className={css.failure} role="alert">
          <h3 className={css.resultTitle}>{t('errorTitle')}</h3>
          <p className={css.errorMessage}>{state.message}</p>
          {state.code !== undefined ? (
            <p className={css.errorCode}>
              {t('errorCodeLabel')}: <code>{state.code}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
