# Control Plane — Web (Next.js standalone)
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @nimbus/web

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /build/apps/web/.next/standalone ./
COPY --from=build /build/apps/web/.next/static apps/web/.next/static
COPY --from=build /build/apps/web/public apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
