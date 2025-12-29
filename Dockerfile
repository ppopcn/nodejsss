# 使用最小化的Alpine Linux镜像
FROM alpine:latest

# 安装必要的工具
RUN apk add --no-cache \
    bash \
    curl \
    wget \
    openssl \
    ca-certificates \
    nodejs \
    npm

# 设置工作目录
WORKDIR /app

# 复制所有文件
COPY . .

# 暴露端口 8000
EXPOSE 8000

# 启动bash控制台并保持运行
CMD ["sh", "-c", "while true; do sleep 30; echo 'Container is running...'; done"]