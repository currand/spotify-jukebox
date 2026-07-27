FROM oven/bun:1.2-slim

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src
COPY data ./data

ENV PORT=8080
ENV MOCK_TRACK_DURATION_MS=180000

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
