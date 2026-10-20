"""kbtext — 产品库解析用到的文本小工具（出图器版）

原 knowledge.py 已被移除：出图器不读外部知识库。
这里只保留解析 markdown 表格需要的纯函数。
"""
from __future__ import annotations
import re
from pathlib import Path

LOCAL_DATA = Path(__file__).resolve().parent / "local_data"
DEFAULT_ROOT = LOCAL_DATA
PACKAGE_FILE = LOCAL_DATA / "scene_package.json"


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("**", "").replace("`", "").replace("\u200b", "")).strip(" -|")


def text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def product_kind(name: str, section: str, model: str = "") -> tuple[str, str]:
    combined = f"{name} {section} {model}"
    if any(x in combined for x in ("灯带", "线性灯")):
        return "light", "灯带" if "灯带" in combined else "线性灯"
    if any(x in combined for x in ("射灯", "筒灯", "吊灯", "壁灯", "灯具", "美颜灯")):
        for v in ("射灯", "筒灯", "吊灯", "壁灯", "美颜灯"):
            if v in combined:
                return "light", v
        return "light", "其他灯具"
    if any(x in combined for x in ("电源", "执行器", "网关", "面板", "窗帘", "中枢", "控制器", "传感器", "模块", "接口", "温控器", "网络", "AP", "交换机", "主机")):
        return "device", next((v for v in ("电源", "执行器", "网关", "面板", "窗帘", "中枢", "控制器", "传感器", "模块", "接口", "温控器", "网络") if v in combined), "智能设备")
    return "device", "智能设备"
