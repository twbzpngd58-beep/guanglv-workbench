# 光律 Guanglv Workbench — 跨平台容器镜像
#
#   docker build -t guanglv-workbench .
#   docker run -d -p 8000:8000 -v guanglv-data:/data guanglv-workbench
#   docker logs <容器名>        # 看启动是否正常
#
# 镜像里已经带好前端构建产物，运行时不装 Node、不联网。

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATA_DIR=/data

WORKDIR /app

# 依赖层单独缓存：只有 requirements 变了才重装
COPY requirements.txt requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt 2>/dev/null \
    || pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8000

# 单机版没有账号密码：容器起来直接可用
CMD ["python", "scripts/docker_start.py"]
