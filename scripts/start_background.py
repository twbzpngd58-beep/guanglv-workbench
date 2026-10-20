"""Detach the installed workbench from a transient terminal (no OS boot service)."""
import os
import socket
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 端口 / 监听地址 / 数据目录都优先读环境变量，其次读 .env。
env_file = ROOT / '.env'
env = {}
if env_file.exists():
    for line in env_file.read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('"\'')
# 兼容旧变量 GUANGLV_PORT；默认端口与 start.py / .env 保持一致。
PORT = os.getenv('GUANGLV_PORT') or os.getenv('PORT') or env.get('GUANGLV_PORT') or env.get('PORT') or '8000'
HOST = os.getenv('HOST') or env.get('HOST') or '0.0.0.0'
DATA_DIR = os.getenv('DATA_DIR') or env.get('DATA_DIR') or 'data'
DATA = Path(DATA_DIR)
if not DATA.is_absolute():
    DATA = ROOT / DATA
python = ROOT / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
if not python.exists():
    raise SystemExit('Run start.py once to install dependencies before background launch.')
# Refuse to start a second listener or stop an unrelated service.
with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1', int(PORT))) == 0:
        raise SystemExit(f'Port {PORT} is already listening. No process was changed.')
DATA.mkdir(parents=True, exist_ok=True)
kwargs = ({'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
          if os.name == 'nt' else {'start_new_session': True})
with (DATA / 'service.log').open('ab', buffering=0) as log:
    process = subprocess.Popen(
        [str(python), '-m', 'uvicorn', 'backend.app:app', '--host', HOST, '--port', PORT],
        cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
        close_fds=True, **kwargs,
    )
(DATA / 'service.pid').write_text(str(process.pid))
print(f'Started detached process {process.pid}; check {DATA}/service.log and /api/health.')
