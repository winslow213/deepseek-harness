/**
 * Plugin install contract for the operator-gated WebUI install namespace:
 * what an install request names and what a successful install reports.
 * @module @deepseek-ai/dsh-host-plugin-install/types
 */

// Type-only: this file extends the shared Remote failure map.
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No bootstrap include entry and no configured override: the target profile cannot be located. */
    'plugin-install/unknown-profile': { readonly reason: string }
    /** The request names an id, specifier, or config the service refuses to write. */
    'plugin-install/invalid-spec': { readonly reason: string }
    /** `pnpm` is not installed on PATH. */
    'plugin-install/pnpm-missing': { readonly profileDir: string }
    /** `pnpm add` exited non-zero or could not run. `output` carries pnpm's own diagnostic tail. */
    'plugin-install/pnpm-failed': { readonly profileDir: string; readonly exitCode: number; readonly output: string }
    /** A registered package specifier cannot be resolved from the profile's installed dependencies. */
    'plugin-install/unresolved-package': { readonly profileDir: string; readonly packageName: string }
    /** A directory upload exceeds the per-file or total byte ceiling. */
    'plugin-install/upload-too-large': { readonly maxBytes: number; readonly actualBytes: number }
    /** A directory upload carries more files than the service accepts. */
    'plugin-install/upload-too-many-files': { readonly maxFiles: number; readonly fileCount: number }
    /** A copy, manifest, patch, or reconcile write failed. */
    'plugin-install/write-failed': { readonly reason: string }
  }
}

/** Operator switch gating the plugin install Remote namespace. */
export interface Config {
  /** Mount only with `enabled: true`; deployments that omit it never expose the namespace. */
  readonly enabled: boolean
  /**
   * Explicit profile directory override for tests and embedders; the running
   * instance self-locates its profile when this is absent.
   */
  readonly profileDir?: string
}

/** The install forms an operator can request. */
export type PluginInstallForm = 'file-dir' | 'upload-directory' | 'npm-bundle' | 'npm-register'

/** Copy a source directory into the profile's `plugins/` dir and register its patch row. */
export interface FileDirInstallSpec {
  readonly form: 'file-dir'
  /** Stable plugin id: the directory name under `plugins/` and the patch row id. */
  readonly id: string
  /** Absolute source directory copied into the profile. */
  readonly sourcePath: string
}

/** `pnpm add` an npm package into the profile and promote bundles into the layer stack. */
export interface NpmBundleInstallSpec {
  readonly form: 'npm-bundle'
  /** npm package spec forwarded to `pnpm add` (name, version range, git, path, ...). */
  readonly spec: string
}

/**
 * Register an installed Cordis npm plugin's startup row: the package is
 * already present (npm-bundle form, or a plain dependency), and this names it
 * in the profile patch layer so the Loader starts it. The row is idempotent
 * under the plugin id, replacing any prior row for the same id.
 */
export interface NpmRegisterInstallSpec {
  readonly form: 'npm-register'
  /** Stable plugin id: the patch row id and the idempotency key. */
  readonly id: string
  /**
   * The Loader entry specifier — the npm package name, optionally with a
   * subpath (e.g. `dsh-some-plugin` or `@scope/pkg/lib/index.js`). Resolved
   * against the profile's installed dependencies at startup.
   */
  readonly packageName: string
  /**
   * Optional plugin config as a JSON object. An empty or whitespace value
   * registers the row without a `config` key.
   */
  readonly configJson?: string
}

/** One file of a browser-picked directory, carried over the Remote channel as base64. */
export interface DirectoryUploadFile {
  /** POSIX-style path relative to the picked directory; safe segments joined by `/`. */
  readonly path: string
  /** File content encoded as base64. */
  readonly content: string
}

/** Install a browser-picked plugin directory: materialize its files, then register its patch row. */
export interface UploadDirectorySpec {
  readonly form: 'upload-directory'
  /** Plugin id: the destination directory name under `plugins/` and the patch row id. */
  readonly id: string
  /** The picked directory's files, each with its relative path. */
  readonly files: readonly DirectoryUploadFile[]
}

/** One install request, discriminated by form. */
export type PluginInstallSpec =
  | FileDirInstallSpec
  | UploadDirectorySpec
  | NpmBundleInstallSpec
  | NpmRegisterInstallSpec

/** Outcome of a completed plugin install. */
export interface PluginInstallResult {
  /** The form that ran. */
  readonly form: PluginInstallForm
  /** Absolute profile directory that received the install. */
  readonly profileDir: string
  /** Plugin id written under `plugins/` and named by the patch row (file-dir, upload-directory, and npm-register forms). */
  readonly pluginId?: string
  /** Bundle names promoted into `dsh.profile.bundles` (npm-bundle form). */
  readonly bundlesAdded?: readonly string[]
  /**
   * Whether the install requested a supervised process restart (the instance
   * runs under a supervisor and self-exited so it relaunches with the new
   * plugin active). Present only when the request actually triggered one.
   */
  readonly restartRequested?: boolean
}
