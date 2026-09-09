/**
 * Dedicated A2UI popup-window bootstrap. This is a minimal React surface, not
 * the full shell: it owns no session, no module table, and no host connection.
 * It announces readiness to the opener, renders the page the opener sends, and
 * lets the standalone renderer post submissions back to the opener.
 */
import { renderA2uiPopup } from '@deepseek-ai/dsh-client-ui-a2ui-render'
import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
// The popup has no ui-theme plugin to inject the design-token sheets at
// runtime, so it imports the same sheets statically: the `--dsw-alias-*` and
// `--dsw-font-*` variables the render components read must exist in this
// document for the form/canvas to match the main window's styling.
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/corner-shape.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/scrollbar.css'

const root = document.getElementById('root')
if (root === null) throw new Error('a2ui popup: missing #root')

interface A2uiInit {
  readonly type: 'a2ui/init'
  readonly surfaceId: string
  readonly page: A2uiPage
}

const opener = window.opener as Window | null
console.log('[a2ui] popup boot', { hasOpener: opener !== null, origin: location.origin, href: location.href })
if (opener === null) {
  root.textContent = 'A2UI pages open from a dsh session; this window cannot be used directly.'
} else {
  // The named window (`a2ui-<surfaceId>`) carries the surface identity, so the
  // readiness announcement can tell the opener which launcher should adopt it.
  const windowSurfaceId = window.name.startsWith('a2ui-') ? window.name.slice('a2ui-'.length) : ''
  const onInit = (event: MessageEvent): void => {
    console.log('[a2ui] popup message', { type: (event.data as Partial<A2uiInit> | null)?.type, origin: event.origin })
    if (event.origin !== location.origin) return
    const data = event.data as Partial<A2uiInit> | null
    if (data?.type !== 'a2ui/init' || typeof data.surfaceId !== 'string' || data.page === undefined) return
    window.clearInterval(readyTimer)
    window.removeEventListener('message', onInit)
    console.log('[a2ui] popup rendering page', data.surfaceId)
    renderA2uiPopup(root, { surfaceId: data.surfaceId, page: data.page })
  }
  window.addEventListener('message', onInit)
  // Re-announce readiness until the opener answers with init: the sidebar may
  // open this window before the chat launcher has mounted its message
  // listener, so a single ready would be dropped and the handshake would stall.
  console.log('[a2ui] popup posting ready to opener')
  const readyTimer = window.setInterval(() => {
    opener.postMessage({ type: 'a2ui/ready', surfaceId: windowSurfaceId }, location.origin)
  }, 300)
}
