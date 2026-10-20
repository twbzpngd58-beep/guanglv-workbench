"""容器内启动器：先生成并打印初始密码，再把进程交给 uvicorn。

和 start.py 的区别：容器里已经有依赖、也不需要虚拟环境，所以这里不做安装，
只保证「第一次启动的人知道密码是什么」这件事。
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path


def main() -> None:
    data = Path(os.environ.get("DATA_DIR", "./data")).resolve()
    data.mkdir(parents=True, exist_ok=True)
    secret = data / ".initial-admin-password"

    first_run = not secret.exists()
    if first_run:
        fd = os.open(secret, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_urlsafe(24) + "\n")
        password = secret.read_text(encoding="utf-8").strip()
        hint = (
            f"\n首次登录：账号 admin　密码 {password}\n"
            "（登录后会被要求改密；密码同时写在 DATA_DIR/.initial-admin-password）\n"
        )
    else:
        hint = "\n账号 admin：用你设定的密码登录（忘了就清空数据卷重来）\n"

    port = os.environ.get("PORT", "8000")
    print(
        f"\n光律 正在启动： http://127.0.0.1:{port}\n{hint}"
        "示例图纸：samples/sample-plan.dxf —— 新建项目后直接上传，能跑通整条流程\n"
        "停止服务：Ctrl+C\n",
        flush=True,
    )

    os.execv(
        sys.executable,
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app:app",
            "--host",
            os.environ.get("HOST", "0.0.0.0"),
            "--port",
            port,
        ],
    )


if __name__ == "__main__":
    main()
