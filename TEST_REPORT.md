# Guanglv Workbench 1.0.0 · 开箱验证报告

验证日期：2026-10-20

验证方式：把仓库 `git clone` 到一个空目录（无 `.venv`、无 `data/`、无 `.env`、无 `node_modules`），
只跑 `python3 start.py`，然后全部通过 HTTP 接口与浏览器实测。**不是在开发机上直接跑源码。**

## 运行环境

- Linux x86_64，Python 3.11.2，全新虚拟环境（启动器自动创建）
- 按 `requirements.lock.txt` 安装依赖；首次启动约 100 秒，之后约 1 秒
- 前端 `tsc -b && vite build` 通过（Node 24）；`frontend/dist/` 已随仓库分发，使用者不需要 Node
- 后端 `python -m compileall` 通过

## 已验证：23 项全过

| 项 | 结果 |
|---|---|
| 首次启动打印初始密码（32 字符，同时写入 `data/.initial-admin-password`） | ✅ |
| 登录 / 强制改密 | ✅ |
| 产品库 230 款 | ✅ |
| 情景包 50 套 / 情景模板 45 个 | ✅ |
| `/api/activity`、`/api/workbench/version` 无 404 | ✅ |
| 新建项目（编号前缀 `GL-`） | ✅ 201 |
| 上传仓库自带 `samples/sample-plan.dxf` → 自动解析 | ✅ 1 空间 / 5 段墙 |
| 空间拆分合并接口 `/space-definition/geometry` | ✅ 不再 404 |
| 导出 HTML / JSON / XLSX / DOCX / PDF / PNG / DXF / ZIP | ✅ 8 种全部 200 |

## 浏览器端实测

- 登录页、工作台首页、项目详情、空间预览（三维）全部正常渲染
- 三维预览：正常出图，俯视图 / 昼夜切换 / 光锥示意可用
- 界面品牌为「光律 GUANGLV」，项目编号显示 `GL-2026-XXXXXX`

## 已知边界

- 三维预览需要可用的 WebGL；无 GPU / 无头浏览器会显示降级提示，不影响项目数据。
- 外部 AI 识图、效果图 Provider 默认关闭；不配置也能完成本地基础出图。
- 导出内容为设计资料，不是正式施工图或正式报价，仍需专业人员复核。
- 本报告只在 Linux 上实测。Windows / macOS 走的是同一个 `start.py`，平台差异处（虚拟环境路径、
  `py` 启动器、字体回退）已按平台分支处理，欢迎提 issue 报告异常。

## 复验命令

```bash
git clone <本仓库地址> gv && cd gv
python3 start.py
curl http://127.0.0.1:8000/api/health
```
