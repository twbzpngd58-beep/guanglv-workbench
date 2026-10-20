"""Authentication and authorization for the workbench.

Sessions are stored in cookies (HttpOnly, SameSite=Lax), 12-hour lifetime, no sliding renewal.
Passwords are hashed with scrypt (N=16384, r=8, p=1, 32-byte salt per user).
"""
from __future__ import annotations
from contextvars import ContextVar
import sqlite3
import hashlib
import hmac
import secrets
import uuid
import os
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROLE_ADMIN = "admin"  # 本地管理员，全部权限
ROLE_OUTSOURCER = "outsourcer"  # 协作账号，只看分配的项目，禁看客户身份与价格

SESSION_LIFETIME_HOURS = 12
MIN_PASSWORD_LENGTH = 8
FORBIDDEN_PASSWORDS = {"123456"}

# 当前请求的登录用户名，中间件设置，event() 落库时写进 events.user。
CURRENT_USER: ContextVar[str] = ContextVar("gv_current_user", default="")


def password_problem(password: str) -> str:
    """新密码不合规时返回原因，合规返回空串。"""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"新密码至少 {MIN_PASSWORD_LENGTH} 位"
    if password in FORBIDDEN_PASSWORDS:
        return "新密码不能是初始密码"
    return ""


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_password(password: str, salt: bytes) -> bytes:
    """Scrypt with N=16384, r=8, p=1, dklen=32."""
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)


def verify_password(password: str, pw_hash: bytes, salt: bytes) -> bool:
    """Constant-time comparison."""
    return hmac.compare_digest(hash_password(password, salt), pw_hash)


def create_session(c: sqlite3.Cursor, user_id: str) -> str:
    """Create a new session token, return it."""
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=SESSION_LIFETIME_HOURS)).isoformat()
    c.execute("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)", (token, user_id, expires_at))
    return token


def get_session_user(c: sqlite3.Cursor, token: str) -> dict | None:
    """Return user dict if session is valid, else None."""
    row = c.execute(
        "SELECT u.id, u.username, u.role, u.disabled, u.must_change_pw FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?",
        (token, now_utc()),
    ).fetchone()
    if not row:
        return None
    if row["disabled"]:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "mustChangePassword": bool(row["must_change_pw"]),
    }


def delete_session(c: sqlite3.Cursor, token: str):
    c.execute("DELETE FROM sessions WHERE token=?", (token,))


def delete_user_sessions(c: sqlite3.Cursor, user_id: str):
    """Delete all sessions for a user (e.g. when disabled or password changed)."""
    c.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def init_auth(c: sqlite3.Cursor):
    """Create auth tables and seed the initial admin account if users table is empty."""
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL,
            pw_hash BLOB NOT NULL,
            salt BLOB NOT NULL,
            disabled INTEGER DEFAULT 0,
            must_change_pw INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS customers(
            id TEXT PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            name TEXT,
            phone TEXT,
            address TEXT,
            channel TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assignments(
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            assigned_at TEXT NOT NULL,
            due_at TEXT NOT NULL DEFAULT '',
            instruction TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(project_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id);
        """
    )
    columns = {r["name"] for r in c.execute("PRAGMA table_info(assignments)")}
    for name in ("due_at", "instruction"):
        if name not in columns:
            c.execute(f"ALTER TABLE assignments ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
    # 客户编号绑定项目：一个项目最多一个客户编号
    if "project_id" not in {r["name"] for r in c.execute("PRAGMA table_info(customers)")}:
        c.execute("ALTER TABLE customers ADD COLUMN project_id TEXT")
    c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_project ON customers(project_id) WHERE project_id IS NOT NULL")
    # Add user column to events if not exists
    if "user" not in {r["name"] for r in c.execute("PRAGMA table_info(events)")}:
        c.execute("ALTER TABLE events ADD COLUMN user TEXT")

    # Seed initial admin account if users table is empty
    if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        admin_id = uuid.uuid4().hex[:16]
        salt = secrets.token_bytes(32)
        secret_file = Path(os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / ".initial-admin-password"
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        if secret_file.exists():
            password = secret_file.read_text().strip()
        else:
            password = secrets.token_urlsafe(24)
            fd = os.open(secret_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(password + "\n")
        pw_hash = hash_password(password, salt)
        c.execute(
            "INSERT INTO users(id, username, role, pw_hash, salt, disabled, must_change_pw, created_at) VALUES(?,?,?,?,?,0,1,?)",
            (admin_id, "admin", ROLE_ADMIN, pw_hash, salt, now_utc()),
        )
