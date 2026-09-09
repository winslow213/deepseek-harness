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
  /**
   * Dynamic option source: the id of a `script` action on the same page whose
   * completion populates this field's `select` options. The action runs once
   * when the page opens (and again whenever the user re-runs it); its
   * completion must be an array of `{ label, value }` or `{ items: [...] }`.
   * Only meaningful for a `select` field; static `options` and `optionsFrom`
   * are mutually exclusive.
   */
  readonly optionsFrom?: string
  /**
   * Host-backed option source: a stable source name resolved by the composed
   * A2UI data provider (the `ctx.a2uiData` capability) when the page opens.
   * The browser requests the source and the provider returns the select
   * options; the model authors only the name, never the data. Only meaningful
   * for a `select` field; `source`, `options`, and `optionsFrom` are mutually
   * exclusive.
   */
  readonly source?: string
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
 * One declarative step a `local` action executes in order. Each step is a
 * restricted operation the browser can perform without running model text:
 *
 * - `set`: assign one field the result of a restricted expression.
 * - `append`: concatenate an expression result onto a field's current value.
 * - `refresh`: re-issue one host-backed data source (a `select` field's
 *   `source`) so its options reload.
 * - `stop`: terminate the page's correlated running job (a `command` action's
 *   run, or a `model` action's background job).
 */
export type A2uiStep =
  | { readonly kind: 'set'; readonly field: string; readonly value: string }
  | { readonly kind: 'append'; readonly field: string; readonly value: string }
  | { readonly kind: 'refresh'; readonly source: string }
  | { readonly kind: 'stop' }

/**
 * How one declarative action executes when the user clicks it.
 *
 * - `local`: the browser runs the page's field logic over the collected
 *   values and shows {@link A2uiAction.result} (an expression over those
 *   values, or a literal) without any model round-trip. A local action is
 *   pure, deterministic, client-side logic. A `local` action may also carry
 *   a {@link A2uiAction.steps} list of imperative steps executed in order
 *   (`set`/`append`/`refresh`/`stop`) after the result is shown.
 * - `model`: the browser serializes the collected values as an ordinary
 *   `user/message` carrying the action id, and the model invokes
 *   {@link A2uiAction.tool} with those values as arguments.
 * - `command`: the browser asks the opener to run {@link A2uiAction.command}
 *   on the harness host (a `{field}`-template command over the collected
 *   values) and shows the produced output in the page. No model round-trip;
 *   the harness shell executes the command with the composed policy.
 */
export type A2uiExecutionMode = 'local' | 'model' | 'command' | 'script'

/**
 * One declarative action rendered as a button beside the submit control. The
 * {@link A2uiAction.execution} mode decides whether the click is resolved in
 * the browser (`local`), routed to the model (`model`), or run on the harness
 * host (`command`).
 */
export interface A2uiAction {
  /** Stable identity the action trigger payload carries. */
  readonly id: string
  /** Button label. */
  readonly label: string
  /**
   * Execution mode; defaults to `model` when absent. `local` never contacts
   * the model, `model` routes the collected values to the model, and
   * `command` runs {@link A2uiAction.command} on the harness host.
   */
  readonly execution?: A2uiExecutionMode
  /** Tool name the model invokes when the action is triggered in `model` mode. */
  readonly tool?: string
  /** What invoking the tool accomplishes; the model uses this to form the call. */
  readonly instruction?: string
  /**
   * `local`-mode result: an expression over the collected field values (or a
   * literal) shown in the page after the action runs. Only meaningful when
   * `execution` is `local`.
   */
  readonly result?: string
  /**
   * `local`-mode step list: declared operations executed in order when the
   * action runs. `set`/`append` carry a `field` (a form field name) and a
   * `value` (a restricted expression over the collected values); `refresh`
   * carries the `source` of a `select` field to reload; `stop` terminates the
   * page's correlated job. Only meaningful when `execution` is `local`.
   */
  readonly steps?: readonly A2uiStep[]
  /**
   * `command`-mode template: a shell command with `{fieldName}` placeholders
   * that the collected field values fill in before the harness host runs it.
   * Only meaningful when `execution` is `command`; a command action without
   * one is rejected at canonicalization.
   */
  readonly command?: string
  /**
   * `command`-mode run bound in milliseconds; absent uses the host shell
   * default and cap. Only meaningful when `execution` is `command`.
   */
  readonly timeoutMs?: number
  /**
   * `script`-mode program: an async body that runs on the host's controlled
   * code runtime. The program calls the injected `a2ui` bindings (pure
   * helpers the A2UI provider grants, e.g. `a2ui.fetch` or `a2ui.text`) and
   * `return`s a JSON value that becomes the action's result. Only meaningful
   * when `execution` is `script`.
   */
  readonly program?: string
  /**
   * `script`-mode binding grant list: the `a2ui.*` member names the program
   * may call. An empty or absent list allows no bindings (pure computation).
   * Only meaningful when `execution` is `script`.
   */
  readonly binds?: readonly string[]
  /**
   * Write-back from a completed `script`/`command` action's outcome into page
   * field values. Each entry names a target field and a dotted selector into
   * the outcome — `value` addresses the whole JSON completion, `value.a.b` a
   * nested member; for `command`, `value.output` and `value.exitCode`. Absent
   * means the outcome is only displayed.
   */
  readonly write?: readonly { readonly field: string; readonly from: string }[]
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
