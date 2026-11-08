# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root=false --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build --workspace apps/api \
 && npm prune --omit=dev --workspace apps/api --include-workspace-root=false \
 && mkdir -p apps/api/node_modules

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
