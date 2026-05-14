FROM node:20-alpine AS development-dependencies-env
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm config set fetch-retries 10 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 300000 \
  && npm ci

FROM node:20-alpine AS production-dependencies-env
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm config set fetch-retries 10 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 300000 \
  && npm ci --omit=dev

FROM node:20-alpine AS build-env
WORKDIR /app
COPY web/package.json web/package-lock.json ./
COPY web/ ./
COPY lib /lib
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
RUN npm run build:ci

FROM node:20-alpine
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm config set fetch-retries 10 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 300000 \
  && npm ci --omit=dev
COPY --from=build-env /app/build /app/build
CMD ["npm", "run", "start"]
