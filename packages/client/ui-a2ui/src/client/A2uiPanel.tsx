/**
 * Dispatcher for one model-authored A2UI page: narrows the page by its
 * `kind` and hands the interactive body to the form or canvas renderer while
 * both keep the shared chrome.
 */

import type { A2uiPanelProps } from './a2ui-chrome.tsx'
import { A2uiCanvasPanel } from './A2uiCanvasPanel.tsx'
import { A2uiFormPanel } from './A2uiFormPanel.tsx'

export type { A2uiPanelProps } from './a2ui-chrome.tsx'

/**
 * Dispatch a model-authored A2UI page to the renderer its `kind` selects.
 * Only an explicit `"canvas"` kind reaches the graph renderer; a form, or a
 * pre-`kind` page recorded before canvas support existed (kind missing,
 * `fields` only), renders as a form.
 */
export function A2uiPanel(props: A2uiPanelProps) {
  const { node } = props
  const { page, surfaceId } = node.data
  return page.kind === 'canvas'
    ? <A2uiCanvasPanel {...props} page={page} surfaceId={surfaceId} />
    : <A2uiFormPanel {...props} page={page} surfaceId={surfaceId} />
}
