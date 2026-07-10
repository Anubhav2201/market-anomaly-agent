# Simple multi-stage build for ingestion-svc. Built from the repo root
# so it can reference the shared src/ and shared/ directories.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY services/ingestion-svc/src ./services/ingestion-svc/src
RUN npx tsc --outDir dist

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/services/ingestion-svc/src/index.js"]
