# 使用官方 Node.js 18 镜像作为基础镜像
FROM node:18-alpine

# 安装必要的系统依赖
RUN apk add --no-cache \
    openssl \
    ca-certificates \
    curl

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装 Node.js 依赖
RUN npm install --production

# 复制应用程序代码
COPY index.js ./

# 创建必要的目录和文件权限
RUN mkdir -p /app/data && \
    chmod +x /app/index.js

# 暴露端口 8000
EXPOSE 8000

# 设置环境变量
ENV NODE_ENV=production

# 启动应用程序
CMD ["node", "index.js"]