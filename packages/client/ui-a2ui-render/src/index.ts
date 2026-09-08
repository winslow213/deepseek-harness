/**
 * The A2UI page renderer as a zero-cordis React component library: the form
 * and canvas renderers, the standalone popup mount, and the popup wire
 * protocol. It is consumed by the web frontend's static assembly (the
 * dedicated `/a2ui.html` popup), so it must stay free of the client Context
 * merges that the `ui-a2ui` plugin owns.
 * @module @deepseek-ai/dsh-client-ui-a2ui-render
 */

export { renderA2uiPopup, type A2uiPopupOptions } from './standalone.tsx'
export {
  a2uiActionMessage, a2uiSubmitMessage,
  type A2uiOpenerMessage, type A2uiPopupMessage,
} from './a2ui-wire.ts'
export { A2uiCanvasPanel, a2uiBendForPoint, a2uiEdgeGeometry, type A2uiCanvasPanelProps } from './A2uiCanvasPanel.tsx'
export { A2uiFormPanel, type A2uiFormPanelProps } from './A2uiFormPanel.tsx'
export type { A2uiPageProps, A2uiTranslate, FormError } from './a2ui-chrome.tsx'
export {
  A2UI_POPUP_IDLE, completionToOptions, invokeAction, reducePopupState,
  type A2uiInvocation, type A2uiPopupAction, type A2uiPopupState,
  type A2uiResolvedOption, type A2uiValues, type A2uiValue,
  type A2uiExpressionEvaluator,
} from './a2ui-runtime.ts'
