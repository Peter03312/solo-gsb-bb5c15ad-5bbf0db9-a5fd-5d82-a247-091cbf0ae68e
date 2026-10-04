FROM node:20-bookworm-slim

# better-sqlite3 优先使用预编译二进制；安装构建工具作为无预编译包时的回退
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷贝源码
COPY server ./server
COPY public ./public

# 数据持久化目录（SQLite）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/marker.db

EXPOSE 3000

# 启动即自动建表并写入示例数据（server/db.js）
CMD ["node", "server/server.js"]
