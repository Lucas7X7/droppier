export type RelayClientMessage =
  | { type: 'hello'; name: string; version: string }
  | { type: 'ping'; t: number }

export type RelayServerMessage =
  | { type: 'ready'; url: string; name: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'request'; id: string; method: string; url: string; headers: Record<string, string>; body: string }
  | { type: 'ping'; t: number }

export type RelayForward =
  | { type: 'response'; id: string; status: number; headers: Record<string, string>; body: string }
  | { type: 'replay'; id: string; method: string; url: string; headers: Record<string, string>; body: string }

/**
 * How often the client says something on a quiet stream.
 *
 * It lives here, next to the wire format, because the relay needs it too: the
 * relay's staleness window asks "is the holder of this name still there", and
 * the only evidence it has is this ping arriving. Set that window below this
 * interval and a healthy client with nothing to send looks dead to the relay
 * for part of every interval — so the two numbers have to move together, and
 * they used to live in two files and did not.
 */
export const RELAY_CLIENT_PING_MS = 20_000

export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
}

/**
 * A frame arrived larger than the stream allows.
 *
 * A stream whose framing is broken cannot be resynchronised — there is no
 * length prefix to skip to the next boundary — so the only safe move is for
 * the caller to drop the connection.
 */
export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`frame exceeded ${limit} characters`)
    this.name = 'FrameTooLargeError'
  }
}

/** A line arrived that is not JSON. */
export class FrameParseError extends Error {
  constructor(line: string, cause: unknown) {
    super(`frame is not valid json: ${causeText(cause)} (${line.slice(0, 80)})`)
    this.name = 'FrameParseError'
  }
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Line-delimited JSON reader, one message per line.
 *
 * `maxFrameChars` bounds the buffer on purpose. Without it, a peer that opens a
 * stream and then never sends a newline grows `#buffer` until the process dies
 * — and both the relay and the client used to call `JSON.parse` unguarded from
 * inside an `on('data')` handler, where a throw is an uncaught exception that
 * takes the whole process down. A single malformed frame was a remote kill.
 *
 * The unit is characters of the decoded string, not bytes of the wire: a frame
 * of 8M four-byte characters is 32MB in memory. It is a bound on what the
 * parser holds, which is the thing that has to stay finite.
 */
export class NdjsonParser {
  #buffer = ''
  readonly #maxFrameChars: number

  constructor(maxFrameChars = 8 * 1024 * 1024) {
    this.#maxFrameChars = maxFrameChars
  }

  /**
   * 0 or less turns the bound off, the way every other limit on the relay takes
   * 0 to mean "off". Without this, a zero limit is not unlimited, it is
   * *minimal*: every line exceeds it, so the first frame a client ever sent
   * dropped its connection.
   */
  get unlimited(): boolean {
    return this.#maxFrameChars <= 0
  }

  /** Characters still held waiting for a newline. */
  get pending(): number {
    return this.#buffer.length
  }

  push(chunk: string): unknown[] {
    this.#buffer += chunk
    const messages: unknown[] = []
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) {
        if (!this.unlimited && line.length > this.#maxFrameChars) {
          this.#buffer = ''
          throw new FrameTooLargeError(this.#maxFrameChars)
        }
        try {
          messages.push(JSON.parse(line))
        } catch (error) {
          throw new FrameParseError(line, error)
        }
      }
      newline = this.#buffer.indexOf('\n')
    }
    // The tail is a partial line. It is the only part that can grow unbounded,
    // so it is the only part worth measuring.
    if (!this.unlimited && this.#buffer.length > this.#maxFrameChars) {
      this.#buffer = ''
      throw new FrameTooLargeError(this.#maxFrameChars)
    }
    return messages
  }
}
