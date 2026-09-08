/**
 * Canvas renderer for model-authored `canvas` A2UI pages: React Flow draws
 * the seeded nodes on an SVG-backed pane the user drags, connects, zooms, and
 * pans. Submitting sends the current graph back to the model as an ordinary
 * user message, so no node state is persisted beyond the log.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from 'react'
import {
  addEdge, Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow,
  useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react'
import type { A2uiAction, A2uiCanvasPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import {
  A2uiChrome, type A2uiPageProps, type A2uiTranslate, type FormError,
} from './a2ui-chrome.tsx'
import css from './A2uiPanel.module.css'
import './react-flow.css'

/** Renderer props for a canvas page, narrowed by the dispatcher. */
export interface A2uiCanvasPanelProps extends Omit<A2uiPageProps, 'page'> {
  /** The narrowed canvas page this renderer draws. */
  readonly page: A2uiCanvasPage
}

/** Custom node payload: the model-authored label, styling hints, and the edit channel. */
type A2uiFlowNodeData = {
  readonly label: string
  readonly detail?: string
  readonly role?: 'start' | 'end'
  /** Locale translator for the editing affordances. */
  readonly t?: A2uiTranslate
  /** Persist a double-click edit back into the node store. */
  readonly onCommit?: (id: string, patch: { label?: string; detail?: string }) => void
} & Record<string, unknown>

/** One React Flow node carrying the A2UI vocabulary in its `data`. */
type A2uiFlowNode = Node<A2uiFlowNodeData>

/** The node card: label, optional detail, and one connection handle per side. */
function A2uiCanvasNodeView({ id, data, selected }: NodeProps<A2uiFlowNode>) {
  const roleClass = data.role === 'start'
    ? css.canvasNodeStart
    : data.role === 'end' ? css.canvasNodeEnd : css.canvasNodePlain
  const [editing, setEditing] = useState(false)
  const [labelDraft, setLabelDraft] = useState(data.label)
  const [detailDraft, setDetailDraft] = useState(data.detail ?? '')
  const cancelled = useRef(false)

  const startEditing = (event: MouseEvent<HTMLDivElement>): void => {
    // Keep the double-click from reaching the React Flow pane, whose default
    // double-click gesture zooms the viewport.
    event.stopPropagation()
    cancelled.current = false
    setLabelDraft(data.label)
    setDetailDraft(data.detail ?? '')
    setEditing(true)
  }

  const commitEditing = (): void => {
    /* v8 ignore next -- React never fires blur on the unmounted inputs after Escape */
    if (cancelled.current) return
    const label = labelDraft.trim()
    if (label.length > 0) {
      data.onCommit?.(id, { label, detail: detailDraft })
    }
    setEditing(false)
  }

  const cancelEditing = (): void => {
    cancelled.current = true
    setEditing(false)
  }

  if (editing) {
    return (
      <div className={`${css.canvasNode} ${roleClass}${selected ? ` ${css.canvasNodeSelected}` : ''}`}>
        <Handle type="target" position={Position.Left} className={css.canvasHandle} />
        <input
          className={`${css.canvasNodeInput} ${css.canvasNodeLabelInput} nodrag`}
          value={labelDraft}
          autoFocus
          aria-label={data.t?.('node.labelPlaceholder')}
          onChange={(event) => { setLabelDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitEditing()
            if (event.key === 'Escape') cancelEditing()
          }}
          onBlur={commitEditing}
        />
        <textarea
          className={`${css.canvasNodeInput} ${css.canvasNodeDetailInput} nodrag nowheel`}
          value={detailDraft}
          rows={2}
          aria-label={data.t?.('node.detailPlaceholder')}
          placeholder={data.t?.('node.detailPlaceholder')}
          onChange={(event) => { setDetailDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancelEditing()
            // Ctrl/Cmd+Enter confirms the multi-line detail text.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitEditing()
          }}
          onBlur={commitEditing}
        />
        <Handle type="source" position={Position.Right} className={css.canvasHandle} />
      </div>
    )
  }

  return (
    <div
      className={`${css.canvasNode} ${roleClass}${selected ? ` ${css.canvasNodeSelected}` : ''}`}
      onDoubleClick={startEditing}
      title={data.t?.('node.editHint')}
    >
      <Handle type="target" position={Position.Left} className={css.canvasHandle} />
      <div className={css.canvasNodeLabel}>{data.label}</div>
      {data.detail !== undefined && <div className={css.canvasNodeDetail}>{data.detail}</div>}
      <Handle type="source" position={Position.Right} className={css.canvasHandle} />
    </div>
  )
}

/** Custom node registry, stable across renders so React Flow keeps its instance. */
const nodeTypes = { a2ui: A2uiCanvasNodeView }

/** Bendable-edge payload carried on each edge's `data`. */
type A2uiFlowEdgeData = {
  /** Perpendicular offset (flow px) of the bend apex from the straight source→target line. */
  readonly bend: number
  /** Locale translator for the label editing affordances. */
  readonly t?: A2uiTranslate
} & Record<string, unknown>

/** One React Flow edge carrying the bend payload. */
type A2uiFlowEdge = Edge<A2uiFlowEdgeData>

/** The custom edge's props: the panel always seeds `data`, so it is required here. */
type A2uiBendableEdgeProps = EdgeProps<A2uiFlowEdge> & {
  readonly data: A2uiFlowEdgeData
}

/** Geometry for one bendable edge. */
interface A2uiEdgeGeometry {
  /** Cubic SVG path from the source handle to the target handle through the apex. */
  readonly path: string
  /** The apex (drag-handle position) in flow coordinates. */
  readonly control: { readonly x: number; readonly y: number }
}

/**
 * Build the cubic path for one edge: bend 0 keeps the line straight; a non-zero
 * bend bows it perpendicular to the source→target segment. The symmetric
 * control points sit one quarter along each end and at 4/3 of the bend, which
 * puts the curve exactly through the apex at its midpoint — so the draggable
 * handle and the label stay on the drawn line instead of floating off it. A
 * zero-length segment degenerates to a point instead of a NaN path because the
 * segment length is normalized to 1.
 *
 * @param sourceX/sourceY/targetX/targetY - the two handle positions in flow coordinates.
 * @param bend - perpendicular offset (flow px) of the apex from the straight line.
 * @returns the SVG path and the apex (handle) position.
 */
export function a2uiEdgeGeometry(
  sourceX: number, sourceY: number, targetX: number, targetY: number, bend: number,
): A2uiEdgeGeometry {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.hypot(dx, dy) || 1
  const normalX = -dy / length
  const normalY = dx / length
  const apexX = (sourceX + targetX) / 2 + normalX * bend
  const apexY = (sourceY + targetY) / 2 + normalY * bend
  const controlX1 = sourceX + (targetX - sourceX) / 4 + normalX * bend * 4 / 3
  const controlY1 = sourceY + (targetY - sourceY) / 4 + normalY * bend * 4 / 3
  const controlX2 = targetX - (targetX - sourceX) / 4 + normalX * bend * 4 / 3
  const controlY2 = targetY - (targetY - sourceY) / 4 + normalY * bend * 4 / 3
  return {
    path: `M ${sourceX} ${sourceY} C ${controlX1} ${controlY1}, ${controlX2} ${controlY2}, ${targetX} ${targetY}`,
    control: { x: apexX, y: apexY },
  }
}

/**
 * The bend that puts the apex under the given flow point: the signed
 * perpendicular distance of the point from the source→target line.
 *
 * @param sourceX/sourceY/targetX/targetY - the two handle positions in flow coordinates.
 * @param point - a flow-coordinate position (e.g. the dragged pointer).
 * @returns the bend value matching that position.
 */
export function a2uiBendForPoint(
  sourceX: number, sourceY: number, targetX: number, targetY: number,
  point: { readonly x: number; readonly y: number },
): number {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.hypot(dx, dy) || 1
  return ((point.x - sourceX) * -dy + (point.y - sourceY) * dx) / length
}

/**
 * The custom edge: a cubic line the user pulls by its apex handle to route it
 * around nodes, and double-clicks to rename. Pulling writes the bend back into
 * the edge's `data`; renaming commits the label into the edge store, so both
 * changes surface in the submitted graph.
 */
function A2uiBendableEdge({
  id, data, label, markerEnd, sourceX, sourceY, targetX, targetY,
}: A2uiBendableEdgeProps) {
  const { screenToFlowPosition, updateEdgeData, setEdges } = useReactFlow()
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const [editing, setEditing] = useState(false)
  const [labelDraft, setLabelDraft] = useState(typeof label === 'string' ? label : '')
  const cancelled = useRef(false)
  const { path, control } = a2uiEdgeGeometry(sourceX, sourceY, targetX, targetY, data.bend)

  const onPointerDown = (event: PointerEvent<SVGGElement>): void => {
    // Keep the pull from reaching the React Flow pane, whose default gesture
    // pans the viewport or starts a selection box.
    event.preventDefault()
    event.stopPropagation()
    draggingRef.current = true
    setDragging(true)
    /* v8 ignore next -- only browsers ship pointer capture; jsdom does not */
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const onPointerMove = (event: PointerEvent<SVGGElement>): void => {
    if (!draggingRef.current) return
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    updateEdgeData(id, { bend: a2uiBendForPoint(sourceX, sourceY, targetX, targetY, point) })
  }

  const onPointerUp = (event: PointerEvent<SVGGElement>): void => {
    draggingRef.current = false
    setDragging(false)
    /* v8 ignore next -- only browsers ship pointer capture; jsdom does not */
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const startEditing = (event: { stopPropagation(): void }): void => {
    // Keep the double-click from reaching the React Flow pane, whose default
    // double-click gesture zooms the viewport.
    event.stopPropagation()
    cancelled.current = false
    setLabelDraft(typeof label === 'string' ? label : '')
    setEditing(true)
  }

  const commitEditing = (): void => {
    /* v8 ignore next -- React never fires blur on the unmounted input after Escape */
    if (cancelled.current) return
    const text = labelDraft.trim()
    if (text.length > 0) {
      // Persist the label into the edge store so the submit projection carries
      // it; the spread keeps the rest of the edge (including the bend) intact.
      setEdges(current => current.map(edge =>
        edge.id === id ? { ...edge, label: text } : edge,
      ))
    }
    setEditing(false)
  }

  const cancelEditing = (): void => {
    cancelled.current = true
    setEditing(false)
  }

  // The panel attaches an arrowhead to every edge it seeds or connects, so
  // markerEnd is always present; the empty fallback only satisfies the
  // optional EdgeProps contract.
  /* v8 ignore next -- every edge the panel creates carries an arrowhead */
  const markerProps = markerEnd === undefined ? {} : { markerEnd }
  // The label sits on the line at the apex; the transform centers it there.
  const labelStyle = { transform: `translate(-50%, -50%) translate(${control.x}px, ${control.y}px)` }

  return (
    <>
      <BaseEdge id={id} path={path} {...markerProps} />
      {/* A wide invisible stroke lets a double-click anywhere on the line — not
          just on the small label chip — start a rename. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="nodrag nopan"
        onDoubleClick={startEditing}
      />
      <g
        className={css.canvasEdgeBend}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <circle cx={control.x} cy={control.y} r={10} className={css.canvasEdgeBendHit} />
        <circle cx={control.x} cy={control.y} r={dragging ? 5 : 3.5} className={css.canvasEdgeBendDot} />
      </g>
      <EdgeLabelRenderer>
        {editing ? (
          <input
            className={`${css.canvasEdgeLabelInput} nodrag nopan nowheel`}
            style={labelStyle}
            value={labelDraft}
            autoFocus
            aria-label={data.t?.('edge.labelPlaceholder')}
            onChange={(event) => { setLabelDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitEditing()
              if (event.key === 'Escape') cancelEditing()
            }}
            onBlur={commitEditing}
          />
        ) : label !== undefined ? (
          <div
            className={`${css.canvasEdgeLabel} nodrag nopan`}
            style={labelStyle}
            title={data.t?.('edge.editHint')}
            onDoubleClick={startEditing}
          >
            {label}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}

/** Custom edge registry, stable across renders so React Flow keeps its instances. */
const edgeTypes = { a2ui: A2uiBendableEdge }

/** Render one model-authored `canvas` page as a draggable, connectable, zoomable node graph. */
export function A2uiCanvasPanel({ page, surfaceId, t, busy, onSubmit, onAction }: A2uiCanvasPanelProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<A2uiFlowNode>(page.nodes.map(node => ({
    id: node.id,
    // Seeded nodes are part of the model-authored page; only their position
    // changes, and the user removes connections (edges), not nodes. The
    // `type` selects the custom card renderer (double-click editing, styled
    // roles); without it React Flow draws its bare default node.
    type: 'a2ui',
    deletable: false,
    position: node.position,
    data: {
      label: node.label,
      ...node.detail === undefined ? {} : { detail: node.detail },
      ...node.role === undefined ? {} : { role: node.role },
    },
  })))

  // Double-click edits land back in the node store so the submit payload
  // carries the user's content. setNodes is stable, so the callback can ride
  // in each node's data without forcing extra renders.
  const commitNodeEdit = useCallback((nodeId: string, patch: { label?: string; detail?: string }): void => {
    setNodes(current => current.map(node =>
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node,
    ))
  }, [setNodes])

  // Hand the edit channel and translator to the node views once the store is
  // ready; the effect re-runs only when the callback or locale changes.
  useEffect(() => {
    setNodes(current => current.map(node => ({
      ...node,
      data: { ...node.data, t, onCommit: commitNodeEdit },
    })))
  }, [setNodes, commitNodeEdit, t])

  const [edges, setEdges, onEdgesChange] = useEdgesState<A2uiFlowEdge>(page.edges.map(edge => ({
    id: edge.id,
    // `a2ui` selects the bendable renderer; its `data.bend` starts straight.
    type: 'a2ui',
    source: edge.source,
    target: edge.target,
    ...edge.label === undefined ? {} : { label: edge.label },
    data: { bend: 0 },
    markerEnd: { type: MarkerType.ArrowClosed },
  })))
  // Hand the translator to the edge views once the store is ready; the effect
  // re-runs only when the locale changes. setEdges is stable. React Flow types
  // `data` optional, but every edge here is panel-created with a `bend`, so the
  // cast (not a runtime fallback) keeps the bendable contract honest.
  useEffect(() => {
    setEdges(current => current.map(edge => ({
      ...edge,
      data: { ...(edge.data as A2uiFlowEdgeData), t },
    })))
  }, [setEdges, t])
  const [error, setError] = useState<FormError | null>(null)
  const [localResult, setLocalResult] = useState<string | null>(null)
  const edgeCounter = useRef(0)

  const onConnect = useCallback((connection: Connection) => {
    setEdges(current => addEdge({
      ...connection,
      id: `a2ui-edge-${Date.now().toString(36)}-${edgeCounter.current++}`,
      type: 'a2ui',
      data: { bend: 0 },
      markerEnd: { type: MarkerType.ArrowClosed },
    }, current))
  }, [setEdges])

  // Reconnectable edges let the user pull an existing line to another handle;
  // React Flow only reports the new connection through onReconnect, so the
  // controlled edge state has to adopt it here or the drag would be a no-op.
  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    setEdges(current => current.map(edge =>
      edge.id === oldEdge.id ? { ...edge, ...newConnection } : edge,
    ))
  }, [setEdges])

  // The arranged graph projected for a submit or an action trigger: node
  // content (label/detail/role) plus position, and edges with their labels.
  const graph = (): Record<string, unknown> => ({
    nodes: nodes.map(node => ({
      id: node.id,
      label: node.data.label,
      ...node.data.detail === undefined ? {} : { detail: node.data.detail },
      position: node.position,
      ...node.data.role === undefined ? {} : { role: node.data.role },
    })),
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...edge.label === undefined ? {} : { label: edge.label },
    })),
  })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy) {
      setError({ key: 'error.busy' })
      return
    }
    onSubmit({ graph: graph() })
  }

  const triggerAction = (action: A2uiAction): void => {
    if (action.execution === 'local') {
      setError(null)
      setLocalResult(action.result === undefined || action.result.trim().length === 0
        ? t('action.localDone')
        : action.result)
      return
    }
    if (busy) {
      setError({ key: 'error.busy' })
      return
    }
    onAction(action, { graph: graph() })
  }

  return (
    <form className={css.root} data-a2ui-surface={surfaceId} onSubmit={submit}>
      <A2uiChrome page={page} error={error} busy={busy} localResult={localResult} t={t} onAction={triggerAction}>
        <div className={css.canvas} data-a2ui-canvas>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            reconnectRadius={16}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background gap={16} />
            <Controls />
          </ReactFlow>
        </div>
      </A2uiChrome>
    </form>
  )
}
