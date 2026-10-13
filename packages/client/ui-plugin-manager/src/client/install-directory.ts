/**
 * State and verbs behind the directory-install dialog. The dialog is a global
 * overlay (a plugin belongs to the profile, not to a Session), while the menu
 * row that opens it lives in the Add-plugin menu and unmounts when that menu
 * closes — so the open state is held here, outside both, rather than inside
 * either one.
 * @module @deepseek-ai/dsh-client-ui-plugin-manager/install-directory
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChangeResult, DirectoryInstallSpec } from '@deepseek-ai/dsh-api-remotes/client'

/** Dialog visibility, the one value the menu row and the dialog share. */
export interface InstallDirectoryState {
  readonly open: boolean
}

/** The shared store type: what the menu row opens and the dialog closes. */
export type InstallDirectoryStore = SnapshotStore<InstallDirectoryState>

/** Create the store the menu row and the dialog share, with the dialog closed.
 * @returns a store with the dialog closed. */
export function createInstallDirectoryStore(): InstallDirectoryStore {
  return createSnapshotStore<InstallDirectoryState>({ open: false })
}

/**
 * What the dialog is injected with: the shared store plus the manager Remote's
 * two directory-form methods. Rejections carry the Host's `ManagementError`
 * code so the dialog renders its own copy for a refusal it recognizes.
 */
export interface InstallDirectoryInjected {
  hooks: { installDirectory: InstallDirectoryStore }
  /**
   * Run one directory-form installation.
   * @param spec - the request, discriminated by form.
   * @returns the persisted change and its observed application outcome.
   */
  installPlugin: (spec: DirectoryInstallSpec) => Promise<ChangeResult>
  /**
   * Remove one directory-form plugin by id.
   * @param id - the plugin id whose patch row and directory to remove.
   * @returns the persisted change and its observed application outcome.
   */
  uninstallPlugin: (id: string) => Promise<ChangeResult>
  /** Close the dialog without an action. */
  closeDialog: () => void
}

/** What the Add-plugin menu row is injected with. */
export interface InstallDirectoryMenuInjected {
  /** Open the dialog; the callback closes the menu first. */
  openDialog: () => void
}
