# hookline relay

The public half of hookline: a tiny process that owns `*.your-domain` and forwards each request
to whichever dev machine claimed that subdomain.

It exists because a stable public URL has to terminate somewhere, and "somewhere" is the part
nobody wants to pay for. The client half (`--tunnel relay`) is free and open source; the server
half is ~200 lines and a $5 VPS.

## How it works

```
provider ──https──> relay (public) ──duplex NDJSON──> hookline dev (your laptop) ──> localhost:4000
```

- The client opens `POST /connect?name=<subdomain>` with `Transfer-Encoding: chunked` and never
  ends the request. That single connection is the tunnel: no WebSocket library, no framing code,
  nothing to keep in sync with a reverse proxy.
- Every message is one line of JSON. The relay writes `{type:"request", id, method, url, headers, body}`
  (body base64, so binary payloads survive); the client answers `{type:"response", id, status, headers, body}`.
  The relay correlates on `id`, so concurrent requests are fine.
- Nothing is stored. The relay is a pipe; your inbox stays on your machine.
- One request per second per subdomain is plenty for webhook testing. Don't route real traffic
  through it.

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
docker build -t hookline-relay -f relay/Dockerfile .
docker run -d --name hookline-relay -p 8080:8080 \
  -e RELAY_DOMAIN=relay.example.com \
  -e RELAY_TOKEN=$(openssl rand -hex 16) \
  hookline-relay
```

The image is `node:24-alpine` and copies only `relay/` and `src/relay-protocol.ts`.

## Operations

- `GET /healthz` lists every connected subdomain with its request count. Use it for uptime checks
  and to see who's holding a name.
- A name is exclusive: the second client to claim it gets `409`. `?force=1` steals it, which is
  what you want when a laptop died without closing the stream.
- Connections that go quiet for 90s are dropped, so a dead client doesn't hold a subdomain
  forever.
- If a client disconnects mid-request, pending requests get `502` instead of hanging.

## Hardening checklist

Before you point this at a real domain:

- [ ] `RELAY_TOKEN` set explicitly and long (32+ random bytes)
- [ ] rate limit `/connect` (it's an unauthenticated-ish surface if the token leaks)
- [ ] keep-alive and body-size limits at the proxy (`client_max_body_size 5m;`)
- [ ] consider a max-connections-per-IP at the proxy
- [ ] log to stdout, ship to journald/cloudwatch and watch the 5xx rate
