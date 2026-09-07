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
  /**
   * Stable identity the submission payload keys values by. A field name must
   * be a plain identifier (`[A-Za-z_][A-Za-z0-9_]*`) so expressions can
   * reference it by bare name.
   */
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
  /**
   * Visibility condition: a restricted expression over sibling field names
   * (see {@link A2uiExpression}). The field is hidden while the expression is
   * falsy; an absent condition always shows it.
   */
  readonly visibleWhen?: string
  /**
   * Custom validation: a restricted expression over sibling field names. When
   * non-empty it must be truthy at submit, otherwise {@link A2uiField.validateMessage}
   * is shown and the submit is refused.
   */
  readonly validateWhen?: string
  /** Failure message shown when {@link A2uiField.validateWhen} is falsy at submit. */
  readonly validateMessage?: string
  /**
   * Read-only computed value: a restricted expression over sibling field names
   * whose result the field always displays. A computed field is never edited
   * directly and its derived value is what the submission payload carries.
   */
  readonly compute?: string
}

/**
 * A restricted, side-effect-free expression the model authors for field
 * visibility, validation, and computation. The grammar is deliberately small
 * so the browser evaluates it without running arbitrary model text: literals
 * (`string`, `number`, `true`/`false`, `null`); references to sibling field
 * names by bare identifier; the operators `=== !== == != < <= > >= && || ! + -
 * * / %`; parentheses; and the string helpers `.length`, `.trim()`,
 * `.includes(x)`, `.startsWith(x)`, `.endsWith(x)`, `.toLowerCase()`,
 * `.toUpperCase()`. Field values are `string | number | boolean | null`.
 */
export type A2uiExpression = string

/**
 * One declarative action rendered as a button beside the submit control. An
 * action is a named model-tool invocation: when the user clicks it, the
 * browser serializes the collected values as an ordinary `user/message`
 * carrying the action id, and the model invokes {@link A2uiAction.tool} with
 * those values as arguments.
 */
export interface A2uiAction {
  /** Stable identity the action trigger payload carries. */
  readonly id: string
  /** Button label. */
  readonly label: string
  /** Tool name the model should invoke when the action is triggered. */
  readonly tool: string
  /** What invoking the tool accomplishes; the model uses this to form the call. */
  readonly instruction: string
}

/** The two page kinds `a2ui_surface` can render: a fillable form or a draggable node canvas. */
export type A2uiPageKind = 'form' | 'canvas'

/** The page chrome both page kinds share. */
export interface A2uiPageBase {
  /** Page heading shown above the content. */
  readonly title: string
  /** Optional explanatory text under the title. */
  readonly description?: string
  /** Submit button label; defaults to the renderer's locale copy when absent. */
  readonly submitLabel?: string
  /** What the model should do with the submitted payload when the user submits. */
  readonly instruction?: string
  /** Optional declarative actions rendered as buttons beside the submit control. */
  readonly actions?: readonly A2uiAction[]
}

/** One draggable node the model seeds a canvas page with. */
export interface A2uiCanvasNode {
  /** Stable node identity the edges reference by. */
  readonly id: string
  /** Node heading shown inside the node card. */
  readonly label: string
  /** Optional secondary text under the label. */
  readonly detail?: string
  /** Initial top-left position in canvas coordinates (the user may move it). */
  readonly position: { readonly x: number; readonly y: number }
  /** Optional visual role the renderer styles distinctly; absent is a plain card. */
  readonly role?: 'start' | 'end'
}

/** One directed connection between two canvas nodes. */
export interface A2uiCanvasEdge {
  /** Stable edge identity. */
  readonly id: string
  /** Source node id (the outgoing end). */
  readonly source: string
  /** Target node id (the incoming end). */
  readonly target: string
  /** Optional text shown on the connector. */
  readonly label?: string
}

/** A form page: structured fields the user fills in and submits. */
export interface A2uiFormPage extends A2uiPageBase {
  readonly kind: 'form'
  readonly fields: readonly A2uiField[]
}

/** A canvas page: a node graph the user arranges, connects, and submits. */
export interface A2uiCanvasPage extends A2uiPageBase {
  readonly kind: 'canvas'
  readonly nodes: readonly A2uiCanvasNode[]
  readonly edges: readonly A2uiCanvasEdge[]
}

/** One model-authored A2UI page the browser renders as a form or a canvas. */
export type A2uiPage = A2uiFormPage | A2uiCanvasPage

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
     * surface: a declarative page the web UI renders as an interactive form or
     * a draggable node canvas. Each open appends a fresh record keyed by
     * `surfaceId`; the latest page for an id wins on replay. The user's later
     * submission reaches the model as an ordinary `user/message`, so this
     * record stays log-only.
     * @param data - stable surface identity and the page definition.
     */
    'a2ui/surface': A2uiSurfaceData
  }
}
