"""容器内启动器：容器里已经有依赖、也不需要虚拟环境，这里只做引导 + 起服务。

单机版没有账号密码，所以不再生成初始口令。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    data = Path(os.environ.get("DATA_DIR", "./data")).resolve()
    data.mkdir(parents=True, exist_ok=True)

    port = os.environ.get("PORT", "8000")
    print(
        f"\n光律 正在启动： http://127.0.0.1:{port}\n"
        "单用户，无需登录。\n"
        f"数据目录：{data}\n"
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
