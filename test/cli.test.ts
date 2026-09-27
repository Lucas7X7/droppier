import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

test('--version, -v and version all print the package version', async () => {
  // `--version` is what everyone types after installing, and it used to answer
  // "unknown command", which reads as a broken install rather than a missing
  // flag. All three spellings, because all three are what people try.
  const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .version as string
  for (const args of [['--version'], ['-v'], ['version']]) {
    const { code, stdout } = await cli(args)
    assert.equal(code, 0, `${args.join(' ')} should exit 0`)
    assert.equal(stdout.trim(), expected, `${args.join(' ')} should print the version`)
  }
})

test('--version works from the built dist, not just the source', async () => {
  // The published tarball runs dist/src/cli.js, where package.json is two
  // levels up rather than one. A version lookup hardcoded to the source layout
  // ships a CLI that answers "unknown" to everyone who installed it.
  const dist = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url))
  if (!existsSync(dist)) return // no build in this checkout; the pack test covers it
  const { stdout } = await run(process.execPath, [dist, '--version'])
  assert.equal(stdout.trim(), '0.1.0')
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
