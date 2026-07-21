FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir vosk==0.3.45

RUN mkdir -p /opt/vosk \
  && curl -fsSL "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip" -o /tmp/vosk-model.zip \
  && python3 -m zipfile -e /tmp/vosk-model.zip /opt/vosk \
  && mv /opt/vosk/vosk-model-small-ru-0.22 /opt/vosk/model \
  && rm -f /tmp/vosk-model.zip

COPY package.json ./
COPY package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --omit=dev --ignore-scripts
RUN npm run db:generate

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/src/server.js"]
