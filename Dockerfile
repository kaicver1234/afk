# Long-running Telegram/Minecraft worker. No HTTP port — Northflank allows a
# service with no ports, so don't add one.
#
# Debian slim (not alpine): the screenshot renderer's native modules (gl,
# canvas) ship no musl prebuilds. Xvfb provides the GLX display headless-gl needs.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb libgl1 libglu1-mesa libxi6 \
      libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps from the lockfile first so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js antibot.js viewer.js ./

# Fall back to a writable path if no volume is mounted, so the container still
# boots (state is then lost on redeploy, which is the expected trade-off).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["xvfb-run", "-a", "node", "index.js"]
