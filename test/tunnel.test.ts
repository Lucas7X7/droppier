import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { parseTunnelUrl, tunnelGuard } from '../src/tunnel/index.ts'

/** Stand-in for a spawned tunnel process. */
class FakeChild extends EventEmitter {
  killed: string[] = []
  kill(signal = 'SIGTERM'): boolean {
    this.killed.push(signal)
    return true
  }
}

test('a healthy tunnel is never killed by the watchdog', async () => {
  // Regression: the guard killed the child 30s after start even after the url
  // had arrived, so `dev` printed a working url and then lost the tunnel.
  const child = new FakeChild()
  const logs: string[] = []
  const guard = tunnelGuard(child, 'ssh', (line) => logs.push(line))
  const urlPromise = Promise.resolve('https://abc.lhr.life')
  assert.equal(await Promise.race([urlPromise, guard.failure]), 'https://abc.lhr.life')
  guard.establish()

  // Well past the 30s watchdog.
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(child.killed, [], 'watchdog must be disarmed once the url arrives')
})

test('a tunnel that dies after connecting is reported, not ignored', async () => {
  const child = new FakeChild()
  const logs: string[] = []
  const guard = tunnelGuard(child, 'ssh', (line) => logs.push(line))
  guard.establish()
  child.emit('exit', 255, null)
  assert.equal(child.killed.length, 0, 'a live tunnel must not be killed')
  assert.match(logs.join('\n'), /tunnel \(ssh\) exited/)
  assert.match(logs.join('\n'), /restart/, 'the user has to be told what to do')
})

test('a tunnel that dies before connecting fails loudly instead of hanging', async () => {
  const child = new FakeChild()
  const guard = tunnelGuard(child, 'ssh')
  child.emit('exit', 1, null)
  await assert.rejects(guard.failure, /exited before serving/)
  assert.deepEqual(child.killed, ['SIGTERM'], 'the orphaned child is cleaned up')
})

test('a tunnel binary that does not exist fails with a readable message', async () => {
  const child = new FakeChild()
  const guard = tunnelGuard(child, 'cloudflared')
  child.emit('error', new Error('spawn cloudflared ENOENT'))
  await assert.rejects(guard.failure, /failed to start: spawn cloudflared ENOENT/)
})

test('reads the public url out of tunnel output', () => {
  // Regression: localhost.run started handing out *.lhr.life domains. The old
  // regex only matched *.localhost.run, so `dev` awaited a url that had already
  // been printed, the 20s timer killed ssh, and the process sat there forever
  // with no tunnel and no error.
  assert.equal(
    parseTunnelUrl('  ·   09bcb19269d899.lhr.life tunneled with tls termination, https://09bcb19269d899.lhr.life'),
    'https://09bcb19269d899.lhr.life',
  )
  assert.equal(
    parseTunnelUrl('  ·   a5c65ebe95f6c8.lhr.life tunneled, https://a5c65ebe95f6c8.lhr.life'),
    'https://a5c65ebe95f6c8.lhr.life',
  )
  assert.equal(
    parseTunnelUrl('  |  https://myapp.localhost.run tunneled with tls termination'),
    'https://myapp.localhost.run',
  )
  assert.equal(
    parseTunnelUrl('  │  https://odd-words-1234.trycloudflare.com'),
    'https://odd-words-1234.trycloudflare.com',
  )
})

test('ignores lines that are not a tunnel url', () => {
  for (const line of [
    '  ·   To set up and manage custom domains go to https://admin.localhost.run/',
    '  ·   see https://localhost.run/docs/forever-free/ for more information.',
    'Open your tunnel address on your mobile with this QR:',
    '  ·   ** your connection id is 1.2.3.4:4406, please mention it if you send me a message.',
    'Warning: Permanently added localhost.run to the list of known hosts.',
    '',
  ]) {
    assert.equal(parseTunnelUrl(line), null, `should not match: ${line}`)
  }
})

test('a url is only taken from a real tunnel host, never from a doc link', () => {
  // The docs link is on the same line as real output in some runs; the first
  // match must be the tunnel, not the documentation.
  assert.equal(
    parseTunnelUrl('see https://localhost.run/docs/ for the tunneled url https://ab12.lhr.life'),
    'https://ab12.lhr.life',
  )
})
