FROM node:24-alpine

WORKDIR /app

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
