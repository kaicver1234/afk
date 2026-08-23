# Long-running Telegram/Minecraft worker. No HTTP port — Northflank allows a
# service with no ports, so don't add one.
#
# Debian slim (not alpine): the screenshot renderer's native modules (gl,
# canvas) ship no musl prebuilds. Xvfb provides the GLX display headless-gl needs.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libgl1 libglu1-mesa libxi6 \
      libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps from the lockfile first so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js antibot.js autoeat.js viewer.js ./

# Start Xvfb ourselves instead of xvfb-run: xvfb-run has failed silently on
# some platforms (missing xauth, display lock races) and swallowed node's logs.
# This script starts Xvfb, waits for it to accept connections, then execs node
# so node is PID 1's child and its stdout/stderr always reach the platform log.
RUN printf '#!/bin/sh\nset -e\nrm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true\nXvfb :99 -screen 0 640x480x24 &\nfor i in $(seq 1 20); do test -e /tmp/.X11-unix/X99 && break; sleep 0.25; done\necho "Xvfb ready (display :99)"\nexport DISPLAY=:99\nexec node index.js\n' > /usr/local/bin/start.sh \
    && chmod +x /usr/local/bin/start.sh

# Fall back to a writable path if no volume is mounted, so the container still
# boots (state is then lost on redeploy, which is the expected trade-off).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["start.sh"]
