# Long-running Telegram/Minecraft worker.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps from the lockfile first so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js antibot.js autoeat.js backup.js chat.js ./

# Railway mounts volumes root-owned while this image runs as `node`, so the
# entrypoint must start as root, chown /data once, then drop back via gosu.
RUN printf '#!/bin/sh\nset -e\nchown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true\ncd /app\nexec gosu node node index.js\n' > /usr/local/bin/start.sh \
    && chmod +x /usr/local/bin/start.sh

# Fall back to a writable path if no volume is mounted, so the container still
# boots (state is then lost on redeploy, which is expected without a volume).
RUN mkdir -p /data && chown -R node:node /data /app

CMD ["start.sh"]
