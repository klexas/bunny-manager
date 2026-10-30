# Bunny Manager: bunny.net CLI + web UI in one image (linux/amd64, linux/arm64).
# The CLI ships glibc binaries, so this uses Debian slim rather than Alpine.
FROM node:22-bookworm-slim

ARG BUNNY_CLI_VERSION=0.21.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@bunny.net/cli@${BUNNY_CLI_VERSION}" \
 && npm cache clean --force \
 && bunny --version

WORKDIR /app
COPY server/package.json ./
COPY server/server.js ./
COPY server/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data/workspace && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HOME=/data \
    NO_COLOR=1

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "server.js"]

LABEL org.opencontainers.image.title="Bunny Manager" \
      org.opencontainers.image.description="Web UI and bunny CLI for managing bunny.net resources" \
      org.opencontainers.image.licenses="MIT"
