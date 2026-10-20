# 验证报告 · v1.3.1（单机发行版）

验证时间：2026-10-20
验证方式：**不在这台开发机上跑源码**——把仓库目录拷到一个空目录，用系统 Python 从零建虚拟环境、装依赖、起服务，再跑接口与浏览器两层。

## 一、环境

| 项 | 值 |
|---|---|
| 系统 | Linux 6.18（fnOS / Debian 12） |
| Python | 3.11.2（`start.py` 自动建 venv 并装 `requirements.lock.txt`） |
| Node | 不需要（`frontend/dist/` 已入仓） |
| 首次装依赖耗时 | ≈ 4 分钟（500 MB 虚拟环境） |
| 二次启动 | ≈ 1 秒 |

## 二、接口层 23 项

脚本逐项调用，全部通过：

```
PASS health → 1.3.1
PASS 版本 1.3.1
PASS 免登录口径（authentication=single-user）
PASS 空库（0 个项目）
PASS 建项目 → 201
PASS 编号前缀 GL- → GL-2026-3D9770
PASS 上传 DXF → 1 个文件
PASS DXF 识别 → 200
PASS 解析出空间 → 1 个
PASS 导出 html / json / xlsx / docx / pdf / png / dxf / zip（8/8，均 >500 B）
PASS 三维场景 JSON → 200
PASS wechat-support.jpg image/jpeg
PASS wechat-business.jpg image/jpeg
PASS wechat-knx.jpg image/jpeg
PASS 检查更新接口 → current=1.3.1 latest=1.0.0 source=tags
PASS 无登录接口（/api/auth/login → 404）

23/23 通过
```

## 三、浏览器实走

| 页面 | 结果 |
|---|---|
| 首页 | 直接进工作台，无登录页；侧栏「本机工作空间 · 单用户 · 无需登录」 |
| 设置 → 版本与更新 | 「检查更新」点下去 → 状态从「尚未检查」变「已是最新」 |
| 设置 → 关于与联系 | 三张二维码并排：技术咨询 / 商务合作 / KNX培训课程咨询 |
| 使用指南弹窗 | 底部「需要帮助？」三张二维码并排，排版正常 |
| 项目详情 | 画布、底图、工具条、属性面板都正常（CSS 类改名后无塌版） |
| 智能情景 → 3D 空间 | `iframe /scene3d/shell.html` 正常加载；空间确认后渲染出 1 个房间、4 段墙 |

## 四、这一版改了什么

- **没有账号密码**：登录门、会话中间件、改密流程、初始口令文件全部移除；`/api/auth/*` 不再存在
- **空库启动**：`SEED_DEMO` 默认 0，不再灌三个示例项目
- **检查更新**：新增 `GET /api/update/check`，按「latest release → 最大版本 tag → main 的 VERSION」三级回退；比较版本号本身
- **三张二维码**：新增 KNX 培训课程咨询，与原有两张一起进使用指南与设置页
- **对外口径**：项目编号 `LM-` → `GL-`；`luma` / `LumaPlanSans` / CSS `.luma3d` 全部改成 `gv` / `GuanglvPlanSans` / `.gv3d`；内部路径与称呼清掉
- **SPA 兜底修好**：`dist` 里的真实文件（二维码、favicon）直接给，不再一律返回 `index.html`
- **发行裁剪**：删掉内部运维脚本（备份、切版本、发版、字体重建）与版本切换接口

## 五、已知边界

- 示例图纸 `samples/sample-plan.dxf` 是一个单房间的合成图：解析出 1 个空间、面积 0（需人工确认后才有净面积）。它用来跑通流程，不代表真实图纸识别率
- 三维只做观感演示，不做照度计算
- 检查更新依赖 GitHub 可达与未限流；失败只在界面上提示，不影响本机使用
