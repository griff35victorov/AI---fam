FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --ignore-scripts
RUN npm run db:generate
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "apps/api/src/server.js"]
