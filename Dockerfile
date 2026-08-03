FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle.config.ts ./
RUN npm run build


FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 8080

CMD ["node", "dist/server.js"]