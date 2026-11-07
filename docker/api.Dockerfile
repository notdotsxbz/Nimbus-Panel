# Control Plane — API
FROM node:22-alpine AS build
WORKDIR /build
# All workspace package.json files must be present or npm install fails (workspaces)
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @nimbus/shared && npm run build --workspace @nimbus/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/package.json ./
COPY --from=build /build/apps/api/dist apps/api/dist
COPY --from=build /build/apps/api/package.json apps/api/package.json
# Compiled shared package (required at runtime by the API)
COPY --from=build /build/packages/shared/dist packages/shared/dist
COPY --from=build /build/packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
