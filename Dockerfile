FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1.2-slim
WORKDIR /app
ENV NODE_ENV=production
ENV JUKEBOX_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
RUN mkdir -p /data
ENV DATABASE_PATH=/data/jukebox.db
EXPOSE 3000
CMD ["bun", "dist/server/index.js"]
