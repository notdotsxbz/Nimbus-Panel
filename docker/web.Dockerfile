# Control Plane — Web (Next.js standalone)
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
COPY apps/web apps/web
RUN npm run build --workspace @nimbus/shared && npm run build --workspace @nimbus/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /build/apps/web/.next/standalone ./
COPY --from=build /build/apps/web/.next/static apps/web/.next/static
COPY --from=build /build/apps/web/public apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
