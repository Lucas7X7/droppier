# hookline

**A stable public URL for webhooks, with an inbox. No signup, no card, no dashboard to configure.**

<!-- Paste a real recording of `bash scripts/demo.sh` here when you publish. -->
```
· hookline dev --tunnel none --port 4999
  hookline · inbox for webhooks you can actually debug
  public   http://127.0.0.1:4999
  inbox    http://127.0.0.1:4999/_hookline?t=devdemo

· a real signed request arrives
  {"ok":true,"id":"0muhlt5dxkow9ol","provider":"stripe","verdict":"valid"}
  -> 200 OK, signature verified

· the provider retries it (same event id, same signature)
  {"ok":true,"id":"0muhlt5jsqkgbbk","provider":"stripe","verdict":"valid"}
  -> linked as a duplicate, not stored as a second charge

· someone tampers with the payload in transit
  -> 200 OK (so the provider stops retrying), stored as invalid

· hookline ls
  id                     age  time   provider event                       verdict     marks      size
  0muhlt5ndokclik    2s 19:40:37 stripe  charge.succeeded             invalid    dup ·     61B
  0muhlt5jsqkgbbk    2s 19:40:37 stripe  charge.succeeded             valid      dup ·     59B
  0muhlt5dxkow9ol    2s 19:40:37 stripe  charge.succeeded             valid      · ·     59B

· hookline replay <id> --chaos corrupt
  replayed 0muhlt5jsqkgbbk chaos:corrupt → 0muhlt5p2xk9vv3 (verdict invalid)
```

```bash
node src/cli.ts dev
```

Every provider gets a URL that survives restarts. Every request that lands there is stored
raw, verified, deduplicated, searchable, replayable and shareable as a link.

---

## The problem this actually solves

Webhook development is three tools that don't talk to each other:

| you need | today you use | the catch |
| --- | --- | --- |
| a public URL | ngrok / cloudflared | permanent domains are paid, quick tunnels change every restart and expire |
| a place to look at payloads | webhook.site, requestbin | a second website, a second account, no relation to your app |
| proof it was signed | your own `crypto.timingSafeEqual` ritual | copy-pasted per provider, untested, breaks silently on key rotation |

hookline is one process that does all three, and it is a dev tool: a single Node process, one
SQLite file, no Docker, no database, no migration to run before you can debug something.

## Install

Node 24+ required — hookline uses the built-in `node:sqlite` and runs TypeScript natively, so
there is **no build step and no runtime dependency**. Nothing to install.

```bash
git clone https://github.com/Lucas7X7/webhook-gateway-.git
cd webhook-gateway-
node src/cli.ts dev
```

Once it is on npm this becomes `npx hookline dev`, and the repository will be renamed to match
the package. Until then the clone above is the whole install.

## Quick start

```bash
# 1. start the inbox, get a public URL
node src/cli.ts dev

# 2. prove the path locally, with a real signature:
node src/cli.ts sign --provider stripe --secret whsec_... \
  --body '{"id":"evt_1","type":"charge.succeeded"}' | sh

# 3. open the inbox that dev printed, hit / to search, j/k to move,
#    r to replay, c to copy a replayable curl
```

Every command below is written as `hookline <cmd>`; from a clone, run `node src/cli.ts <cmd>`
or alias it once:

```bash
alias hookline="node $PWD/src/cli.ts"   # $PWD expands now, so the rest of this file works verbatim
```

## What you get

**Signatures verified, not guessed.** Provider is detected from headers, then the signature is
checked against the real scheme — including the parts people get wrong:

| provider | scheme | notes |
| --- | --- | --- |
| stripe | `t=…,v1=…` | timestamp tolerance, accepts rotated secrets during a key change |
| github | `sha256=…` hex | falls back to `x-hub-signature` sha1 |
| slack | `v0=…` over `v0:ts:body` | timestamp tolerance |
| svix | base64 over `id.ts.body` | `whsec_` secrets are base64-decoded, not used raw |
| shopify | base64 body HMAC | dedupes on `x-shopify-webhook-id` |
| twilio | sha1 over url + sorted params | needs `--public-url`, otherwise stays `unverified` instead of guessing |
| generic | `x-hookline-signature` | for your own endpoints, with the same tolerance rules |

Four verdicts, not two: `valid`, `invalid`, `stale` (correct signature, timestamp outside the
window — a real replay attack signal) and `unverified` (no secret configured). A tampered payload
is **stored and flagged**, never dropped, because "the webhook arrived and I couldn't read it" is
exactly the thing you're debugging at 2am.

**Retries are visible.** Providers retry on non-2xx. hookline links each retry to the original
event instead of quietly giving you three copies of the same charge.

**Replay, and prove your handler is idempotent.** `replay` re-sends the exact bytes and headers.
`--chaos` deliberately breaks them:

```bash
hookline replay <id> --chaos strip       # signature removed   -> unverified
hookline replay <id> --chaos truncate    # half a payload      -> invalid
hookline replay <id> --chaos corrupt     # bad signature       -> invalid
hookline replay <id> --chaos delay       # 2s late             -> timeout test
```

If your handler survives `--chaos` with no double charge, it survives production.

**Share the evidence, not a screenshot.** Every event has a public, unlisted page
(`/_hookline/p/<id>`, and `.json` for the raw record). Signature headers are stripped from that
page unless you also pass the token, so it's safe to paste in an issue or a Slack thread.

**A curl that actually works.** `hookline show <id>` and the inbox's `c` key print the exact
request, shell-quoted, ready to re-run. It's a tested command, not a template — there's a test
that pipes it through `sh` and asserts the request that comes out the other side.

## Tunnel options

`--tunnel` picks how the public URL is made. This is the honest version of the table, including
what is actually free:

| tunnel | signup | cost | URL survives restart | notes |
| --- | --- | --- | --- | --- |
| `ssh` (default) | none | free | yes, with `--name` | localhost.run; paste your public key once (no account) to claim a sticky subdomain |
| `cloudflared` | none | free | **no** | random `trycloudflare.com` URL on every run |
| `relay` | none | ~US$5/mo of VPS | yes | self-hosted, in this repo, your own domain |
| `none` | — | — | — | local only, for CI and tests |

```bash
hookline dev --tunnel ssh --name myapp        # https://myapp.localhost.run
hookline dev --tunnel relay --relay-url https://relay.example.com --name myapp
```

A stable free URL is not free for *someone*: the tunnel has to terminate on a public machine.
The `ssh` mode rents that from localhost.run, `relay` mode is you renting it for the price of a
VPS. There is no third option, and any tool claiming otherwise is either burning money or
expiring your URL.

## Self-hosting the relay

```bash
docker build -t hookline-relay -f relay/Dockerfile .
docker run -p 8080:8080 -e RELAY_DOMAIN=relay.example.com -e RELAY_TOKEN=$(openssl rand -hex 16) hookline-relay
```

Then point a wildcard certificate at it (see `relay/Caddyfile.example`) and connect:

```bash
hookline dev --tunnel relay --name myapp \
  --relay-url https://relay.example.com \
  --relay-token "$RELAY_TOKEN"
```

The relay is ~200 lines: one duplex NDJSON stream per client, requests correlated by id, 30s
timeout, stale connections reaped. See `relay/README.md`.

## CLI

```
hookline dev [options]      start the inbox and expose a public URL
hookline ls                 list captured events (ids can be abbreviated)
hookline show <id>          one event, its headers, a replayable curl and a share link
hookline replay <id>        re-send an event, optionally with --chaos
hookline sign               print a correctly signed curl for any provider
hookline stats              counts by provider, duplicates, invalid signatures
hookline purge              delete stored events (--all or --before 2026-01-01)
hookline relay              run the self-hosted relay
```

`hookline dev --help` lists every flag. Config also comes from `.hookline.json` (gitignored) or
`HOOKLINE_*` env vars; see `examples/hookline.json`.

## Using it as a library

The server is three functions; nothing about it requires the CLI.

```ts
import { loadConfig } from 'hookline/src/config.ts'
import { openStore } from 'hookline/src/store.ts'
import { createHooklineServer } from 'hookline/src/server.ts'
import { verifySignature } from 'hookline/src/verify.ts'

const config = loadConfig(process.cwd(), { port: 4000, secrets: { stripe: process.env.STRIPE_SECRET! } })
const store = openStore(config.db)
const server = createHooklineServer({ config, store, publicUrl: { current: null } })
await server.listen(config.port, config.host)
```

`verifySignature` is the piece worth importing on its own: a constant-time, rotation-tolerant
implementation of the seven schemes above, with no dependencies.

## Security posture

- **The inbox is locked by default when a tunnel is open.** hookline generates a token and prints
  it; every `/api/*` and UI request needs it (`?t=`, `Authorization: Bearer`, or `x-hookline-token`).
- **Public share pages redact signature headers** unless you pass both `?raw=1` and the token.
  Bodies are *not* redacted — a share link shows the full payload, so treat it like the payload.
- **Retention is 7 days by default**; `hookline purge --before` or `--all` clears it.
- **Secrets come from env or a gitignored file.** They are never written to the database, and
  never printed in the UI.
- This is a development tool. It stores raw request bodies on disk, and its tunnel makes your
  localhost reachable from the internet. Don't run it in production, and don't point it at
  anything you'd mind an attacker reading.

## Development

```bash
npm test          # 63 tests: signatures, store, http, curl, cli, relay end-to-end
npm run typecheck
```

Node's built-in test runner, no test framework. The relay tests spawn the real relay and push a
signed Stripe event through `relay → local server → inbox`, so the tunnel path is covered rather
than mocked. CI runs the suite on Node 24 and current, typechecks, and builds the relay image to
check it still starts and still rejects a bad token.

### Record the demo

The block at the top of this file is meant to be a real terminal recording:

```bash
bash scripts/demo.sh          # prints a scripted session
# then: asciinema rec -c demo.cast   (or any terminal recorder) → convert to gif
```

## License

MIT
