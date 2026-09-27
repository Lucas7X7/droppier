# droppier relay

The public half of droppier: a tiny process that owns `*.your-domain` and forwards each request
to whichever dev machine claimed that subdomain.

It exists because a stable public URL has to terminate somewhere, and "somewhere" is the part
nobody wants to pay for. The client half (`--tunnel relay`) is free and open source; the server
half is one file with no dependencies and a $5 VPS.

## How it works

```
provider ──https──> relay (public) ──duplex NDJSON──> droppier dev (your laptop) ──> localhost:4000
```

- The client opens `POST /connect?name=<subdomain>` with `Transfer-Encoding: chunked` and never
  ends the request. That single connection is the tunnel: no WebSocket library, no framing code,
  nothing to keep in sync with a reverse proxy.
- Every message is one line of JSON. The relay writes `{type:"request", id, method, url, headers, body}`
  (body base64, so binary payloads survive); the client answers `{type:"response", id, status, headers, body}`.
  The relay correlates on `id`, so concurrent requests are fine.
- Nothing is stored. The relay is a pipe; your inbox stays on your machine.
- A public relay with a shared token is a shared relay: every client can claim any subdomain that
  is free. That is fine for a team or a self-hosted box, and worth remembering if you offer one to
  people you don't know. Don't route real traffic through it.

## Run it

```bash
RELAY_DOMAIN=relay.example.com RELAY_TOKEN=$(openssl rand -hex 16) node relay/server.ts
```

`RELAY_TOKEN` is required in practice. If you don't set one, the relay generates a random token at
boot and prints it — clients must present it as `Authorization: Bearer <token>` or `?token=`.

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | port to listen on |
| `RELAY_DOMAIN` | – | base domain; `<name>.<domain>` routes to a client |
| `RELAY_TOKEN` | generated | shared secret clients must present |
| `RELAY_TIMEOUT_MS` | `30000` | how long to wait for a client before returning 504 |
| `RELAY_DEBUG` | – | `1` logs every forwarded request |
| `RELAY_MAX_CONNECTIONS` | `64` | tunnels held at once, all clients together |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `4` | tunnels one source address may hold |
| `RELAY_RATE_PER_MIN` | `600` | requests forwarded *to* one client, per minute |
| `RELAY_MAX_INFLIGHT` | `64` | requests one client may have unanswered at once |
| `RELAY_MAX_FRAME_CHARS` | `8388608` | longest single NDJSON line accepted from a client, in characters |
| `RELAY_MAX_FRAMES_PER_SEC` | `200` | frames one client may send per second |
| `RELAY_MAX_RESPONSE_BYTES` | `5242880` | largest response body a client may return |
| `RELAY_MAX_RESPONSE_HEADERS` | `100` | most headers a client may return |
| `RELAY_CONNECT_PER_MIN` | `30` | `/connect` attempts per source address, good token or not |
| `RELAY_STALE_MS` | `60000` | silence after which a name's holder counts as dead |
| `RELAY_ALLOW_FORCE` | `0` | `1` lets `?force=1` steal from a *live* connection |
| `RELAY_TRUST_PROXY` | `0` | `1` keys the per-IP limits on `X-Forwarded-For` |
| `RELAY_TRACKED_IP_CAP` | `4096` | remembered source addresses before the reaper collects |
| `RELAY_SWEEP_MS` | `15000` | how often the reaper drops idle bookkeeping |

`0` disables a limit, which is useful when the same process sits behind a proxy that already does
the limiting properly.

`RELAY_STALE_MS` defaults to three times the client's ping interval, and the two are the same
number: `RELAY_CLIENT_PING_MS` in `src/relay-protocol.ts` is both what the client pings at and
where the default comes from, so they cannot drift apart again. They did once, and the window was
the smaller of the two — a healthy client with nothing to say is quiet for a whole interval by
design, so every live-but-idle tunnel counted as dead for 5s out of every 20. Override it only
with a reason: at or below the ping interval, `?force=1` can take a tunnel that is right there.

Two of these deserve more than a row in a table:

**`RELAY_RATE_PER_MIN` protects the client, not the relay.** The relay is already busy serving a
request the moment it accepts one; the limit exists because an open forwarder is an invitation to
fill someone's inbox and disk. It is a token bucket, so a client that has been quiet can take a
burst and then settles to `RELAY_RATE_PER_MIN / 60` per second. A flat per-second counter would
punish exactly the wrong client — the one whose provider fires a burst of retries after an outage.

**`RELAY_TRUST_PROXY` decides whether the per-IP limits do anything at all.** The deployment above
is "point Caddy at `:8080`", which means every client arrives from the proxy's own address, so
with the default `0` all of your users share one per-IP budget: 4 connections and 30 connect
attempts a minute between all of them. Set it to `1` when nothing but your own proxy can open a
socket to that port. If the port is reachable from the internet directly, a client can send its
own `X-Forwarded-For` and mint a fresh budget per request, which is why it is off by default. The
relay prints a warning at boot when the per-IP limits are on and the header is not being trusted.

## TLS

The relay speaks plain HTTP on purpose — terminate TLS in front of it. With Caddy, a wildcard
certificate is one line:

```
relay.example.com, *.relay.example.com {
    reverse_proxy 127.0.0.1:8080
    flush_interval -1
}
```

`flush_interval -1` matters: it disables response buffering, which is what a streaming NDJSON
tunnel needs. See `Caddyfile.example`.

With nginx, the equivalent is `proxy_buffering off;` plus `proxy_request_buffering off;` on the
`/connect` location, and a `proxy_read_timeout` above 60s.

## Docker

```bash
docker build -t droppier-relay -f relay/Dockerfile .
docker run -d --name droppier-relay -p 8080:8080 \
  -e RELAY_DOMAIN=relay.example.com \
  -e RELAY_TOKEN=$(openssl rand -hex 16) \
  droppier-relay
```

The image is `node:24-alpine` and copies only `relay/` and `src/relay-protocol.ts`.

## Operations

- `GET /healthz` is public and says only that the process is up, how long it has been, and how
  many tunnels it holds. Keep it that way: uptime checks and load balancers need it, and anything
  that names your tenants or prints their URLs is one unauthenticated request away from being a
  list of who is working on what.
- `GET /status` needs the token (`Authorization: Bearer <token>`, no query-string form) and lists
  every tunnel, the limits currently in force, and how many source addresses are being remembered.
- A name is exclusive: the second client to claim it gets `409`.
- `?force=1` steals a name, but by default only from a holder that has said nothing for
  `RELAY_STALE_MS`. A laptop that died without closing its stream is the case this exists for, and
  nobody has spoken on that stream in a while. Anyone with the shared token can reach this
  endpoint, so stealing from a *live* tunnel means any tenant can point another tenant's webhooks
  at their own machine. `RELAY_ALLOW_FORCE=1` restores the old behaviour if you run a private
  relay and would rather have the convenience than the isolation.
- Connections that go quiet for 90s are dropped, so a dead client doesn't hold a subdomain
  forever. That is independent of `RELAY_STALE_MS`, which only decides what `force=1` may take.
- If a client disconnects mid-request, pending requests get `502` instead of hanging.
- A client that sends malformed NDJSON, a line over `RELAY_MAX_FRAME_CHARS`, or frames faster than
  `RELAY_MAX_FRAMES_PER_SEC` has *its* connection dropped. The relay does not restart: one bad peer
  is one bad peer's problem.

## Hardening checklist

Before you point this at a real domain:

- [ ] `RELAY_TOKEN` set explicitly and long (32+ random bytes)
- [ ] `RELAY_TRUST_PROXY=1` if the port is reachable only through your own proxy — otherwise the
      per-IP limits are counting your proxy
- [ ] keep-alive and body-size limits at the proxy (`client_max_body_size 5m;`)
- [ ] log to stdout, ship to journald/cloudwatch and watch the 5xx and 429 rates
