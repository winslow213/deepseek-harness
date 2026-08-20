/**
 * Browser-safe A2UI page vocabulary: the durable `a2ui/surface` event payload
 * and the declarative page schema the model authors and the web UI renders
 * natively. Pure types — no host-side value imports — so the browser
 * renderer and the host tool share one declaration.
 *
 * @module @deepseek-ai/dsh-tool-a2ui-surface/types
 */

/** Interactive widget kind the A2UI renderer can draw for one field. */
export type A2uiFieldType = 'text' | 'textarea' | 'select' | 'number' | 'checkbox'

/** One selectable option of a `select` field. */
export interface A2uiFieldOption {
  /** Human-readable option text. */
  readonly label: string
  /** Stable option value carried into the submission payload. */
  readonly value: string
}

/** One declarative form control the A2UI panel renders. */
export interface A2uiField {
  /** Stable identity the submission payload keys values by. */
  readonly name: string
  /** Human-readable control label. */
  readonly label: string
  readonly type: A2uiFieldType
  /** Whether the user must fill the field before submitting. */
  readonly required?: boolean
  /** Placeholder shown while the control is empty. */
  readonly placeholder?: string
  /** Selectable options; meaningful only for `select`. */
  readonly options?: readonly A2uiFieldOption[]
  /** Short help text shown under the control. */
  readonly help?: string
}

/** One model-authored A2UI page the browser renders as an interactive form. */
export interface A2uiPage {
  /** Page heading shown above the fields. */
  readonly title: string
  /** Optional explanatory text under the title. */
  readonly description?: string
  readonly fields: readonly A2uiField[]
  /** Submit button label; defaults to the renderer's locale copy when absent. */
  readonly submitLabel?: string
  /** What the model should do with the collected values when the form is submitted. */
  readonly instruction?: string
}

/** The durable payload of one `a2ui/surface` event. */
export interface A2uiSurfaceData {
  /** Stable identity the model and the renderer use to correlate updates and submissions. */
  readonly surfaceId: string
  readonly page: A2uiPage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens, or with an explicit `surfaceId` replaces, one model-authored A2UI
     * surface: a declarative page the web UI renders as an interactive form.
     * Each open appends a fresh record keyed by `surfaceId`; the latest page
     * for an id wins on replay. The user's later submission reaches the model
     * as an ordinary `user/message`, so this record stays log-only.
     * @param data - stable surface identity and the page definition.
     */
    'a2ui/surface': A2uiSurfaceData
  }
}
