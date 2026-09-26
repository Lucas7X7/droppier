FROM node:24-alpine

WORKDIR /app

# The relay has no dependencies; it only needs its own source and the shared
# NDJSON protocol module.
COPY relay/server.ts ./relay/server.ts
COPY src/relay-protocol.ts ./src/relay-protocol.ts

ENV PORT=8080
EXPOSE 8080

# Run unprivileged. The node image already ships a `node` user.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node runs the .ts file directly (native type stripping, Node 24+): no build step.
CMD ["node", "relay/server.ts"]
