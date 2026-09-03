/**
 * Wire protocol between the remote hub and each remote-agent daemon.
 *
 * The channel is a persistent outbound TCP connection opened by the agent
 * (direction B: machines behind NAT dial the hub) carrying one JSON object
 * per line. Both endpoints are our own code, so a plain newline-delimited
 * JSON channel keeps `shell/` dependency-free; there is no WebSocket
 * handshake or framing to negotiate.
 */

import type { Socket } from 'node:net'

/** Upper bound on a single JSON line, protecting both ends from runaway buffers. */
export const MAX_FRAME_BYTES = 1 << 20

/** First message from an agent; the hub answers `hello_ack` or closes. */
export interface HelloFrame {
  type: 'hello'
  agentId: string
  /** Token mode: the hub looks up `user` and compares `token`. */
  user?: string
  token?: string
  /** Pairing mode: the hub looks up a one-time pairing code bound to a user. */
  pairUuid?: string
  /** Real directories the agent serves, advertised for diagnostics and early hub rejection. */
  roots: string[]
  /** Command basenames the agent will execute, advertised for diagnostics. */
  commands: string[]
}

export interface HelloAckFrame {
  type: 'hello_ack'
  agentId: string
  user: string
}

export interface ErrorFrame {
  type: 'error'
  message: string
}

export interface PingFrame {
  type: 'ping'
}

export interface PongFrame {
  type: 'pong'
}

/** Execute `argv` on the agent host with an optional cwd and timeout. */
export interface ExecRequest {
  type: 'exec'
  id: string
  /** argv[0] must be an allowlisted command basename; the agent enforces it. */
  argv: string[]
  /** Working directory; must resolve under an agent `--root`. */
  cwd?: string
  /** Kill the process group after this many milliseconds. */
  timeoutMs?: number
}

/** Kill an in-flight `exec`'s process group (agent no-ops for unknown ids). */
export interface KillRequest {
  type: 'kill'
  id: string
}

/** Stream the content of one file (the `cat` primitive) to the hub. */
export interface FsReadRequest {
  type: 'fs:read'
  id: string
  /** Absolute path; must resolve under an agent `--root`. */
  path: string
  /** Reject files larger than this many bytes. */
  maxBytes?: number
}

export type RequestFrame = ExecRequest | KillRequest | FsReadRequest

export interface StreamFrame {
  type: 'stream'
  id: string
  /** `stdout`/`stderr` for exec, `data` for fs:read. */
  channel: 'stdout' | 'stderr' | 'data'
  data: string
}

export interface ExitFrame {
  type: 'exit'
  id: string
  code: number | null
  signal: string | null
}

export interface RequestErrorFrame {
  type: 'request-error'
  id: string
  message: string
}

/** Frames an agent sends toward the hub. */
export type AgentOutFrame = HelloFrame | PongFrame | StreamFrame | ExitFrame | RequestErrorFrame

/** Frames the hub sends toward an agent. */
export type HubOutFrame = HelloAckFrame | ErrorFrame | PingFrame | RequestFrame

/** Serialize a frame as one newline-terminated JSON line. */
export function encodeFrame(frame: AgentOutFrame | HubOutFrame): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
}

/** Write a frame to a socket, ignoring writes after the socket closed. */
export function sendFrame(socket: Socket, frame: AgentOutFrame | HubOutFrame): void {
  if (!socket.destroyed) socket.write(encodeFrame(frame))
}

/**
 * Build a chunk handler that splits a byte stream on newlines and emits one
 * parsed frame per line. `onFrame` receives every complete line; `onViolation`
 * fires once when the unparsed buffer outgrows `MAX_FRAME_BYTES`.
 */
export function makeLineReader(
  onFrame: (frame: unknown) => void,
  onViolation?: (message: string) => void,
): (chunk: Buffer) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk.toString('utf8')
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.length === 0) continue
      try {
        onFrame(JSON.parse(line))
      } catch (error) {
        onViolation?.(`bad JSON frame: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (pending.length > MAX_FRAME_BYTES) {
      const message = 'frame buffer exceeded 1 MiB'
      pending = ''
      onViolation?.(message)
    }
  }
}
