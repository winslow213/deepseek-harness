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
    /** The request names an id or path the service refuses to write. */
    'plugin-install/invalid-spec': { readonly reason: string }
    /** `pnpm` is not installed on PATH. */
    'plugin-install/pnpm-missing': { readonly profileDir: string }
    /** `pnpm add` exited non-zero or could not run. `output` carries pnpm's own diagnostic tail. */
    'plugin-install/pnpm-failed': { readonly profileDir: string; readonly exitCode: number; readonly output: string }
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
export type PluginInstallForm = 'file-dir' | 'upload-directory' | 'npm-bundle'

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
export type PluginInstallSpec = FileDirInstallSpec | UploadDirectorySpec | NpmBundleInstallSpec

/** Outcome of a completed plugin install. */
export interface PluginInstallResult {
  /** The form that ran. */
  readonly form: PluginInstallForm
  /** Absolute profile directory that received the install. */
  readonly profileDir: string
  /** Plugin id written under `plugins/` and named by the patch row (file-dir and upload-directory forms). */
  readonly pluginId?: string
  /** Bundle names promoted into `dsh.profile.bundles` (npm-bundle form). */
  readonly bundlesAdded?: readonly string[]
}
