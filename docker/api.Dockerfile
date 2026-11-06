# Control Plane — API
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @nimbus/api

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/apps/api/dist apps/api/dist
COPY apps/api/package.json apps/api/package.json
COPY packages/shared packages/shared
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
