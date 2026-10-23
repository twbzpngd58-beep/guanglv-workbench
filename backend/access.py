"""High-risk endpoint guard: LAN-only by default, admin token for everyone else.

判断来源：
  · 直连（没有任何转发头）：按 TCP 对端地址判断，192.168.0.0/16 与本机算局域网。
  · 经反代：只有对端是可信反代（TRUSTED_PROXIES，默认本机）时才看 X-Forwarded-For，
    取最右侧第一个不是可信反代的地址；不可信对端带来的转发头一律忽略，防伪造。
  · 本机反代转来、解析结果仍是回环地址的请求 = 公网隧道（Cloudflare / Tailscale Funnel 都先到
    本机 Caddy，Caddy 不信任外来转发头，会把 X-Forwarded-For 写成 127.0.0.1），按外网处理。
外网调用高危接口须带请求头 X-Admin-Token，值与环境变量 ADMIN_TOKEN 一致；未配置 ADMIN_TOKEN 时外网一律拒绝。
"""
from __future__ import annotations

import hmac
import ipaddress
import os
import re
from contextvars import ContextVar

DENIED_DETAIL = "此操作仅限局域网或需管理口令"
TOKEN_HEADER = "x-admin-token"
FORWARD_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "tailscale-funnel-request")

# 当前请求的来源地址，供 events 落库时记录。
CLIENT_IP: ContextVar[str] = ContextVar("gv_client_ip", default="")

HIGH_RISK = [
    ("DELETE", re.compile(r"^/api/projects/[^/]+$")),
    ("DELETE", re.compile(r"^/api/projects/[^/]+/files/[^/]+$")),
    ("POST", re.compile(r"^/api/workbench/version/activate$")),
    ("POST", re.compile(r"^/api/app/versions/[^/]+/rollback$")),
    ("POST", re.compile(r"^/api/update/apply$")),
    ("POST", re.compile(r"^/api/products/sync$")),
    ("POST", re.compile(r"^/api/lighting3d/products/sync$")),
    ("POST", re.compile(r"^/api/knowledge/sync$")),
    ("POST", re.compile(r"^/api/projects/[^/]+/recognition/(replace|clear|reset-auto-plan)$")),
    ("POST", re.compile(r"^/api/projects/[^/]+/space-definition/discard-ai-draft$")),
    ("POST", re.compile(r"^/api/projects/[^/]+/versions/[^/]+/restore$")),
]


def _networks(env: str, default: str):
    nets = []
    for part in os.getenv(env, default).split(","):
        part = part.strip()
        if part:
            try:
                nets.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                pass
    return nets


def lan_networks():
    return _networks("LAN_NETWORKS", "192.168.0.0/16,127.0.0.1/32,::1/128")


def trusted_proxies():
    return _networks("TRUSTED_PROXIES", "127.0.0.1/32,::1/128")


def _ip(text: str):
    text = (text or "").strip().strip('"')
    if text.startswith("[") and "]" in text:
        text = text[1:text.index("]")]
    elif text.count(":") == 1:  # IPv4:port
        text = text.split(":")[0]
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return None
    return ip.ipv4_mapped if getattr(ip, "ipv4_mapped", None) else ip


def _within(ip, nets) -> bool:
    return ip is not None and any(ip.version == n.version and ip in n for n in nets)


def resolve(peer: str, headers) -> tuple[str, bool]:
    """Return (client ip text, is_lan) for one request."""
    peer_ip = _ip(peer)
    if peer_ip is None and not any(headers.get(h) for h in FORWARD_HEADERS):
        # 对端不是 IP（进程内测试客户端 / unix socket），不可能来自网络，按本机处理
        return peer or "local", True
    forwarded = any(headers.get(h) for h in FORWARD_HEADERS)
    if not forwarded:
        return (str(peer_ip) if peer_ip else peer or ""), _within(peer_ip, lan_networks())
    proxies = trusted_proxies()
    if not _within(peer_ip, proxies):
        # 不可信对端自带的转发头不算数
        return (str(peer_ip) if peer_ip else peer or ""), _within(peer_ip, lan_networks())
    chain = [_ip(x) for x in (headers.get("x-forwarded-for") or "").split(",") if x.strip()]
    chain = [x for x in chain if x is not None]
    client = next((x for x in reversed(chain) if not _within(x, proxies)), chain[0] if chain else peer_ip)
    if client is None or client.is_loopback:
        # 本机反代转来、来源仍是本机 → 公网隧道
        return (str(client) if client else ""), False
    return str(client), _within(client, lan_networks())


def is_high_risk(method: str, path: str) -> bool:
    return any(method == m and rx.match(path) for m, rx in HIGH_RISK)


def token_ok(headers) -> bool:
    expected = os.getenv("ADMIN_TOKEN", "")
    given = headers.get(TOKEN_HEADER) or ""
    return bool(expected) and hmac.compare_digest(given.encode(), expected.encode())
