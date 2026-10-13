/** The Add-plugin menu row that opens the shared directory-install dialog. */
import type { ReactNode } from 'react'
import { IconAgentPresetOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InstallDirectoryMenuInjected } from './install-directory.ts'
import css from './InstallDirectoryMenuItem.module.css'

/** Props: the Add-plugin owner's dismissal, the open action, and the plugin dictionary. */
export type InstallDirectoryMenuItemProps =
  PropsRuntime<'plugins.add.actions'>
  & InjectFace<InstallDirectoryMenuInjected>
  & PropsLocale<'pluginManager'>

/**
 * Offer the directory-install dialog from the Add-plugin menu.
 * @param props - the open action, the menu's dismissal, and the locale seat.
 * @returns the menu row.
 */
export function InstallDirectoryMenuItem({ t, openDialog, onDismiss }: InstallDirectoryMenuItemProps): ReactNode {
  return (
    <MenuItemButton icon={<IconAgentPresetOutlineRegular size={14} />} onSelect={() => {
      // The menu unmounts this row, so the dialog is opened only after it closes.
      onDismiss()
      openDialog()
    }}>
      <span className={css.copy}>
        <span>{t('installDirectoryMenu')}</span>
        <span className={css.description}>{t('installDirectoryMenuDescription')}</span>
      </span>
    </MenuItemButton>
  )
}
