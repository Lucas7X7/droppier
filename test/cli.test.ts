import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

async function cli(args: string[], timeout = 15_000): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { timeout })
    return { code: 0, stdout }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '' }
  }
}

test('dev --help prints usage instead of opening a tunnel', async () => {
  // Regression: `--help` after a subcommand used to be ignored, so `dev` started
  // an SSH tunnel and the process never exited.
  const { code, stdout } = await cli(['dev', '--help'], 10_000)
  assert.equal(code, 0)
  assert.match(stdout, /usage/)
  assert.match(stdout, /droppier dev \[options\]/)
  assert.doesNotMatch(stdout, /localhost\.run/)
})

test('an unknown command fails with usage and a non-zero exit', async () => {
  const { code, stdout } = await cli(['nope'])
  assert.equal(code, 1)
  assert.equal(stdout, '')
})

test('sign prints a comment-free, executable curl', async () => {
  const { code, stdout } = await cli([
    'sign',
    '--provider',
    'stripe',
    '--secret',
    'whsec_test_secret',
    '--body',
    '{"id":"evt_1","type":"charge.succeeded"}',
  ])
  assert.equal(code, 0)
  const lines = stdout.split('\n')
  assert.match(lines[0]!, /^curl /, 'first line must be a runnable command')
  assert.match(stdout, /-d '\{"id":"evt_1","type":"charge\.succeeded"\}'/)
  assert.match(stdout, /-H 'stripe-signature: /)
  // A `#` line is fine after the command, but never inside it: the command is
  // pasted into a shell, and a comment in the middle would truncate it.
  const commentAt = lines.findIndex((line) => line.startsWith('#'))
  const commandEnd = lines.findLastIndex((line) => line.trim() !== '')
  if (commentAt !== -1) assert.ok(commentAt >= commandEnd, 'comment must come last')
  assert.doesNotMatch(lines.slice(0, commentAt === -1 ? undefined : commentAt).join('\n'), /^\s*#/m)
})

test('sign without a body still produces a valid command', async () => {
  const { code, stdout } = await cli(['sign', '--provider', 'github', '--secret', 'hunter2'])
  assert.equal(code, 0)
  assert.match(stdout, /^curl /m)
  assert.match(stdout, /x-hub-signature-256: sha256=/)
})
