# 使用官方Node.js 18镜像作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /tmp

# 安装必要的系统依赖
RUN apk add --no-cache \
    ca-certificates \
    curl \
    && rm -rf /var/cache/apk/*

# 复制应用文件
COPY package.json index.js ./

# 安装Node.js依赖
RUN npm install --production

# 设置环境变量
ENV NODE_ENV=production
ENV HOME=/tmp

# 暴露端口
EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ps aux | grep -v grep | grep "node index.js" || exit 1

# 启动应用
CMD ["node", "index.js"]
