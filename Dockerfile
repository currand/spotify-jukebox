FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lock bun.lockb* ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1.2-slim
WORKDIR /app
ENV NODE_ENV=production
ENV JUKEBOX_ENV=production
# `bun build --target bun` inlines all dependencies into dist/server/index.js,
# so no node_modules or package.json are needed at runtime.
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R bun:bun /data
ENV DATABASE_PATH=/data/jukebox.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER bun
CMD ["bun", "dist/server/index.js"]
