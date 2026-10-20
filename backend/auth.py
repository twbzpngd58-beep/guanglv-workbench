"""单机版的账号口径。

发行版没有账号体系：不建用户表、不存密码、不做会话，所有请求都按本机管理员处理。
这两个常量与 CURRENT_USER 只服务于内部权限辅助函数（协作账号分支永远不走）。
"""
from __future__ import annotations
from contextvars import ContextVar

ROLE_ADMIN = "admin"
ROLE_OUTSOURCER = "outsourcer"

# 事件日志落库时取当前操作人；单机版恒为空。
CURRENT_USER: ContextVar[str] = ContextVar("guanglv_current_user", default="")
