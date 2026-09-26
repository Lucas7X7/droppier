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

export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
}

export function* decodeMessages<T>(chunk: string): Generator<T> {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    yield JSON.parse(trimmed) as T
  }
}

export class NdjsonParser {
  #buffer = ''

  push(chunk: string): unknown[] {
    this.#buffer += chunk
    const messages: unknown[] = []
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) messages.push(JSON.parse(line))
      newline = this.#buffer.indexOf('\n')
    }
    return messages
  }
}
