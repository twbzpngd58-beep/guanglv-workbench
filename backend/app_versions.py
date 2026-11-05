"""本机版本历史 / 回退 / 本版更新。

数据来自本机版本库（默认 ../光律版本库，可用 GUANGLV_VERSION_STORE 覆盖）。
回退本身交给版本库的 version_rollback.sh：预存当前版本 → 停服务 → 恢复 → 重启 → 自检。
这里只负责把请求异步交给 helper，先让 HTTP 响应返回，避免服务被自己停掉时请求断在半路。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
VERSION_STORE = Path(
    os.getenv("GUANGLV_VERSION_STORE") or (ROOT.parent / "光律版本库")
).resolve()
VERSIONS = VERSION_STORE / "versions"
ROLLBACK_SCRIPT = VERSION_STORE / "scripts" / "version_rollback.sh"
BUILD_BASELINE = ROOT / "build-baseline.json"

router = APIRouter(prefix="/api/app", tags=["app-versions"])
_rollback_lock = threading.Lock()
_rollback_started = False

# 当前版本的更新内容（给人看，不参与构建）。以后升版在这里追加一条。
RELEASE_NOTES = {
    "2.1.0": {
        "releasedAt": "2026-11-05",
        "items": [
            {
                "date": "2026-11-05",
                "title": "电箱实拍形态面板",
                "detail": "单击强电箱 / 弱电箱，右边栏按实拍里的样子呈现：黑框箱体、导轨、模块正面、位数标记条、空位白板，"
                        "同屏再出一张按线色走的总线接线图。设备以单条 22.5P（405mm）导轨为基准嵌进箱体，"
                        "占几位、排不排得下一眼可见；位数只认知识库产品库的规格尺寸，表里没有的型号标「位数待填」、不计入占位。"
                        "感应器在天花、驱动器在吊顶、面板在 86 底盒，都不画进配电箱；网桥与云主机进弱电箱。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "一键返回电箱",
                "detail": "选中型号看完产品属性，可以一键回到所属电箱面板，不用再回画布去点那个箱体符号——"
                        "选型时「产品 ↔ 电箱」来回对照是常态，入口必须双向。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "飞利浦网桥单灯单控",
                "detail": "总线智能接入飞利浦 WiZ / Hue 灯具载体：这类灯是 Wi-Fi 灯，并入 KNX 只多加一台网桥，"
                        "与 DALI 一样单灯单控，因此不再有「回路」——回路是一组灯共用一路开关的分组，单灯单控下不成立。"
                        "口径：逐灯混用（同项目可有 DALI 灯、开闭灯、WiZ/Hue 灯），网桥每层 1 台、每台最多 40 个设备；"
                        "后端 backend/circuit_rules.py 是同一套判据的另一份实现。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "描图有墙带引导",
                "detail": "图片底图描边界时新增一层辅助：后端算出的墙带候选变成引导线，鼠标点上去落在墙上，"
                        "配正交锁与实时长度读数。引导线是几何候选不是真相（贴墙柜体、双线家具也会被算成墙带），"
                        "所以可一键关掉回到自由描图；正交锁只扶正「差一点就横平竖直」的点，斜墙不逼成正交。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "尺度标定落到实米",
                "detail": "标定改为一次性把画布单位换算到「26 单位＝1 米」的全局口径（POST /api/projects/{pid}/scale-apply）。"
                        "以前给每个消费方加比例参数，三维、导出、光斑、遮光共 13 处各算各的米，漏一处就是面积、开孔、"
                        "灯光三套尺寸互相打脸；现在标定完仍用同一个不变量。只动画布单位字段，带 M/mm 后缀的真实尺寸不动。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "单灯调光随情景留",
                "detail": "单灯调过的亮度 / 色温在情景里持久保留，卡片显示「已调」并给出原值 → 现值；"
                        "情景与回路均值不再互相覆盖。",
                "category": "feat",
            },
            {
                "date": "2026-11-05",
                "title": "业主页带走三维",
                "detail": "交付给业主的 HTML 现在可以把三维灯光场景一起带走（渲染、情景、视角都在同一个单文件里），"
                        "不再只有平面图。",
                "category": "feat",
            },
        ],
    },
    "2.0.1": {
        "releasedAt": "2026-11-05",
        "items": [
            {
                "date": "2026-11-05",
                "title": "凹形空间落点归位",
                "detail": "L/C 形空间以前按外接框取中心、取角点，缺角那块其实是隔壁的地盘：布灯落点、设备圈心、房间名与面积、"
                        "「CAD 解析」角标、挑空说明都会写到别人家地上。现在统一改用真实边界内部点。"
                        "实测 5 个项目 14 间有边界的凹形房，标签出界 14 → 0；两盏灯的归属从「演示区」纠正为「茶室」。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "家具按真实轮廓出图",
                "detail": "画过边界的家具（L 形灶台、到顶柜、书架）以前只把宽深外接框交给导出与三维："
                        "coco 展厅那台灶台 3.49 ㎡ 被画成 11.23 ㎡，到顶柜在三维里挤成一堵墙。"
                        "成品图、灯光分布示意图、DXF、三维夜景现在都带轮廓点。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "灯光分布图能出了",
                "detail": "图纸识别的门窗只挂边界区间、没有 x/y，以前渲染时直接读坐标："
                        "轻则画布刷一屏 NaN（实测 36 条控制台报错），重则「图像生成未完成：'x'」整张图 422。"
                        "现在洞口坐标按边界区间现推，推不出的跳过；同一项目实测 422 → 200，控制台报错 36 → 0。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "识别门窗进清单",
                "detail": "门窗清单以前只列手绘且挂了房间的洞口，识别来的 9 条一条不显示，改不了高度也删不掉。"
                        "同墙并排的门窗命中区互相压着，第一下常被邻门符号吃掉：现在第一下选中、第二下才拖动，"
                        "选中项挪到最上层绘制。实测同一项目清单 0 → 9 行。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "色温按产品标称",
                "detail": "产品标称 2200K / 5000K 以前会被夹回单色默认 3000K，还被要求补「偏离 3000K·原因未填」，"
                        "一改就和下单型号对不上。现在选了型号 / 关联产品的灯不套默认口径、不要求原因，"
                        "下拉里保留标称值并标「产品标称」；手动改色温仍要写原因。导出清单同步。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "三维同向·单灯亮度",
                "detail": "三维里沙发正面撞墙、床尾朝床头那侧（转角换算与镜像帧不一致）已修正；"
                        "调一盏灯的亮度以前会把同回路一整片灯一起改，现在逐灯值优先。"
                        "光锥与光束面片单面渲染导致的穿帮一并修掉。",
                "category": "fix",
            },
            {
                "date": "2026-11-05",
                "title": "全开全关不再丢",
                "detail": "这两条以前从本机知识库接口取，接口返回空时弹窗仍写着「固定写入」，"
                        "套用后情景里却没有全开 / 全关。现在随程序自带定义，不依赖本机知识库是否同步。",
                "category": "fix",
            },
        ],
    },
    "2.0.0": {
        "releasedAt": "2026-11-03",
        "items": [
            {
                "date": "2026-11-03",
                "title": "品牌 → 型号级联选型",
                "detail": "布灯与灯具配置按「品牌 → 型号」级联；选中型号后功率、色温、光束角按产品收口并带产品图。随源码附带飞利浦 WiZ 与 FLOS 目录，FLOS 欧元目录价单独标注，不混入人民币单价。",
                "category": "feat",
            },
            {
                "date": "2026-11-03",
                "title": "情景内已改灯具可见",
                "detail": "情景草稿相对已保存情景改过的灯，在灯具页签与单灯卡片显示「已改」以及亮度/色温的原值 → 现值；切换或新增情景遇到未保存修改会先确认，不静默丢稿。",
                "category": "feat",
            },
            {
                "date": "2026-11-03",
                "title": "三维真实情景与实体家具",
                "detail": "情景页三维改用项目真实情景与精确亮度，不再使用写死的预置；「带渲染」模式下的家具按图纸类型显示为实体，零渲染保留占地体块。",
                "category": "feat",
            },
            {
                "date": "2026-11-03",
                "title": "单灯就地解锁",
                "detail": "情景里遇到非调光或单色温灯具，可在单灯卡片直接标为可调光 / 双色温，控制方式同步升级为 DALI 或蓝牙 Mesh，并给出原因与保存条。",
                "category": "feat",
            },
            {
                "date": "2026-11-03",
                "title": "0 图层空间识别修正",
                "detail": "画在 0 图层上的家具、洁具轮廓不再被当成房间；开放区与走廊按真实边界确认，避免空间划分错位。",
                "category": "fix",
            },
            {
                "date": "2026-11-03",
                "title": "coco 演示项目",
                "detail": "随源码附带 samples/coco-demo.json：5 个空间 / 39 盏灯 / 4 个设备 / 37 件家具。为便于演示，已移除全部情景和灯具、设备价格；在项目列表「导入项目」即可打开。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "情景三维改为「优邑呈现」",
                "detail": "情景页三维改用优邑珺和原件的渲染内核，项目场景（墙/地/家具/灯位/回路）由后端实时注入；同一个版本号下提供两个可选呈现方式。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "零渲染 / 带渲染",
                "detail": "零渲染：墙地保留暗轮廓、不画材质，家具与光锥/光斑为主体；带渲染：参考亮墙 #f0e8da + 木地 #cbb08c + 家具 + 灯光。默认零渲染，可随时切换。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "IES 窄/宽光快捷入口",
                "detail": "情景页顶栏直接切换 IES 窄光 10° / 宽光 57°（复用已确认的配光管线），一键还原；情景亮度通过 postMessage 驱动参考内核回路。",
                "category": "feat",
            },
        ],
    },
    "1.10.0": {
        "releasedAt": "2026-10-27",
        "items": [
            {
                "date": "2026-10-27",
                "title": "夜景 = 参考优邑的空间表现形式",
                "detail": "夜景不再只是调暗：墙体改成参考的亮色（#f0e8da）、地面木色（#cbb08c）、家具切换成参考式体块、灯具暖光，并默认套 IES 窄光束；背景保持暗场，光锥/光斑为主体。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "白天恢复工作台空间渲染",
                "detail": "切回日景时，墙体/地面/家具/灯具材质与模型全部复原，HUD/视角图层面板回来，保持原有空间渲染形态；日夜来回切换不残留。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "夜景窄光束与用户 IES 互不覆盖",
                "detail": "用户手动导入或记忆恢复的 IES 优先；只有没有用户 IES 时，夜景才自动套参考窄光束；还原光锥后回到默认。",
                "category": "fix",
            },
        ],
    },
    "1.9.0": {
        "releasedAt": "2026-10-27",
        "items": [
            {
                "date": "2026-10-27",
                "title": "日 / 夜 = 两套三维表现形式",
                "detail": "白天：工作台空间渲染形态——日景、墙地家具正常渲染、完整控件（HUD/视角图层面板）；夜晚：优邑参考三维态——暗场 #0d0e12、精简界面、光锥/光斑为主体。切换时界面密度跟着变，不再只是调亮度。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "默认夜晚参考态",
                "detail": "首次进入为夜晚参考态（精简 + 夜景）；切到白天自动回到完整空间渲染；每个项目/楼层记住上次选择。",
                "category": "feat",
            },
        ],
    },
    "1.8.0": {
        "releasedAt": "2026-10-27",
        "items": [
            {
                "date": "2026-10-27",
                "title": "三维默认观感对齐优邑参考",
                "detail": "进入情景页默认「精简 + 夜景」：只留空间名，暗场里灯光光锥与光斑成为主体；可在控件条切回完整视图 / 日景。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "夜景补光压暗、光锥更突出",
                "detail": "夜景补光从 hemi1.2/dir2.2·0.6/amb2.2 降到 hemi0.55/dir1.05·0.28/amb0.75，背景 #0d0e12：墙面暗下来，光锥/光斑对比更强，接近优邑参考的夜景观感。",
                "category": "feat",
            },
            {
                "date": "2026-10-27",
                "title": "默认态修正",
                "detail": "首次进入不再被内核默认夜/日状态干扰：精简、夜景、光锥状态确定；有记忆时优先用记忆。",
                "category": "fix",
            },
        ],
    },
    "1.7.1": {
        "releasedAt": "2026-10-27",
        "items": [
            {
                "date": "2026-10-27",
                "title": "折叠条不再压住面板 × / 视角图层",
                "detail": "紧凑「⋯」从右上角改到顶部居中（窄屏下移让开 HUD）；展开条贴左，右上角的 × 与「视角 / 图层」不会再被覆盖或吞掉点击（1.7.0 审计 N1）。",
                "category": "fix",
            },
            {
                "date": "2026-10-27",
                "title": "窄屏「视角 / 图层」能打开面板",
                "detail": "≤760px 的隐藏规则只作用于「未打开」的面板，内核「视角 / 图层」加的 gl-open 不再被压掉（1.7.0 审计 N2）。",
                "category": "fix",
            },
            {
                "date": "2026-10-27",
                "title": "恢复提示改成可见 toast",
                "detail": "视角 / 面板 / IES 的「已恢复上次状态」提示不再只写在折叠条里，改在画面底部弹一条 3 秒 toast，折叠状态也能看到（1.7.0 审计 N3）。",
                "category": "fix",
            },
        ],
    },
    "1.7.0": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "视角记忆",
                "detail": "记住上次选的「户型图 / 鸟瞰 / 室内视角」，再进三维自动恢复；恢复发生在内核自动取景之前，不会再被默认视角抢走。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "面板显隐记忆",
                "detail": "用「控件」、「×」或「视角 / 图层」收起/展开面板后，刷新沿用上次选择；窗口缩放导致的自动开合不记忆，不会跟用户操作打架。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "IES 配光记忆",
                "detail": "上次导入的 .ies 刷新后自动重放并提示「已恢复上次 IES」；点「还原光锥」或换场景导致失效时自动清除，不反复报错。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "首访不再误写偏好",
                "detail": "修 1.6.0 轮询在三维就绪前误判状态、首访写入 night/cone 并闪烁提示的问题（加就绪门闸）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "控件条避让 HUD",
                "detail": "自适应折叠同时检查面板与左上 HUD 矩形：1260–1370px 窗口下不再压住「看灯光演示」chip（1.6.0 审计 P3）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "面板「×」可关闭、窄屏入口恢复",
                "detail": "用「控件」打开的面板现在能被 × 关掉；窄屏「视角 / 图层」按钮恢复出现，不再被强制隐藏规则压住。",
                "category": "fix",
            },
        ],
    },
    "1.6.0": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "三维快捷键全局可用",
                "detail": "M=精简、N=昼夜、C=光锥，焦点在情景页任意位置都能用（外层页面转发给三维内核）；输入框/文本域/可编辑区聚焦时不触发。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "偏好按项目/楼层记忆",
                "detail": "精简/夜景/光锥的记忆键改为 gv.v24.<项目>.<楼层>.*，多项目不再共用一套偏好；旧键自动迁移，首次进入仍是原默认。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "三维页定时器合并",
                "detail": "面板同步（500ms）与控件条同步（350ms）合并为一个 400ms 循环，减少一条常驻轮询。",
                "category": "fix",
            },
        ],
    },
    "1.5.0": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "三维控件条记住上次状态",
                "detail": "精简 / 夜景 / 光锥的选择记在本机（gv.v24.*），刷新后沿用；首次访问仍是完整视图 + 日景 + 光锥开，不改变原表现。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "三维页快捷键 M / N / C",
                "detail": "M=精简、N=昼夜、C=光锥；输入框/文本域/可编辑区聚焦时不触发，按钮 title 已写明。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "控件条与面板双向同步",
                "detail": "在面板里点「灯光演示」「光锥示意」，控件条着色与状态文字自动跟随（350ms 轮询，以面板真实状态为准），并写入记忆。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "窄屏面板默认收起、⋯ 不再压 HUD",
                "detail": "≤760px 三维面板默认收起，点「控件」展开；紧凑「⋯」改贴右，不再与左上 HUD 重叠（审计建议的基线修正）。",
                "category": "fix",
            },
        ],
    },
    "1.4.2": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "控件条不再遮挡三维面板",
                "detail": "控件条从右上角移到顶部居中，宽屏不再压住面板关闭按钮；≤1340px 窄窗口下也能正常打开面板（审计 N1）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "夜景切换与壳层一致",
                "detail": "控件条「夜景」改为走壳层自己的「灯光演示」按钮，墙面/家具材质与 HUD 状态同步，不再出现回日景后 chip 仍高亮（审计 N2）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "「控件」按钮语义修正",
                "detail": "完整视图下点击「控件」会真正收起面板，再点展开；精简视图下点击展开面板，不再是空操作（审计 N3）。",
                "category": "fix",
            },
        ],
    },
    "1.4.1": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "默认视图回归原表现",
                "detail": "「精简」改为可选并默认关闭，进三维就是完整视图 + 日景，和 1.3.4 原表现一致（铁律 1：只做加法、不推翻表现形式）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "光锥可随时开闭",
                "detail": "控件条新增「光锥」快捷开关，复用原有「光锥示意」图层，一键开闭光锥（不影响灯具亮度与地面光斑）。",
                "category": "fix",
            },
        ],
    },
    "1.4.0": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "三维预览入口修复",
                "detail": "七步条里的「3 · 三维预览」原来被写死成禁用，点了没反应（现场 bug.mp4）；现已放开：点击直接打开三维预览层，已确认项目走后端 no-op 不改数据。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "三维页精简视图",
                "detail": "情景页三维默认精简：收起 HUD、视角/图层、图例、灯型清单，只留空间名；右上「控件」可展开面板，「精简/完整」一键切换。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "三维页 IES 导入 / 还原",
                "detail": "三维页可直接选 .ies 文件：前端按 LM-63 解析，按灯具半峰值角重算光锥（R=H·tan(半峰角)），并按锥侧面积做能量归一，宽配光不再洗白；「还原光锥」回到导入前状态。",
                "category": "feat",
            },
            {
                "date": "2026-10-26",
                "title": "夜景补光强化",
                "detail": "夜景把家具提亮到可见（轮廓与木色/布色看得清），灯的光锥与光斑仍是画面最亮主体；日景恢复原值。",
                "category": "feat",
            },
        ],
    },
    "1.3.4": {
        "releasedAt": "2026-10-26",
        "items": [
            {
                "date": "2026-10-26",
                "title": "3D 情景画布取景与观感修正",
                "detail": "竖屏室内视角放宽（fov 74 / 机位 1.75），选视角后自动收起手机面板；电视柜改为木体石面 + 双面门板，阳台 5m 级门改玻璃细框，柜内隔板、接触阴影、暖光墙面保留。渲染 calls 707→645、tris 38838→29072，家具 17→15 件（去重）。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "3D 可见性修复：曝光 / 光锥 / 取景 / 光束角",
                "detail": "夜景曝光、光锥材质、家具对比、相机取景与真实光束角修正；IES 半峰值插值解析修复；灯带功率按 W/m × 长度进入回路与导出。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "公开仓库剔除仅本机使用的扩展",
                "detail": "功能编号 / 隐藏 / 改动记录的实现移到部署目录外的本地扩展，公开源码与公开构建不再包含入口与 data-fid 标注；本机部署能力不变，画图与设计功能无减少。",
                "category": "fix",
            },
            {
                "date": "2026-10-26",
                "title": "发版守卫与检查单落地",
                "detail": "VERSION / README / package.json / package-lock / build-baseline / RELEASE_NOTES 一致性守卫、发行包前置校验与 GitHub Actions 版本检查；版本号规则与发版检查单成文。",
                "category": "fix",
            },
        ],
    },
    "1.3.3": {
        "releasedAt": "2026-10-23",
        "items": [
            {
                "date": "2026-10-23",
                "title": "修设置页被刷回工作台",
                "detail": "1.3.2 的版本面板只要读到「上次更新成功」就会自动刷新，进设置页被刷回工作台；改为只有本次点「立即更新」完成后才刷新一次，并按目标版本记账，进页面只读状态。",
            },
            {
                "date": "2026-10-23",
                "title": "老用户更新脚本更稳",
                "detail": "光律更新脚本优先用 python3 下载更新助手（macOS 自动读系统代理；curl 只认环境变量），变量名后接中文标点改用 ${VAR}，已是最新时按成功处理。",
            },
            {
                "date": "2026-10-23",
                "title": "真机更新数据零变化",
                "detail": "本机实测 1.3.1→1.3.2、1.3.2→1.3.3 各一次：项目、产品、版本、上传文件、SQLite 完整性更新前后逐项一致；data/ 与 .env 不动，更新前自动快照。",
            },
        ],
    },
    "1.3.2": {
        "releasedAt": "2026-10-23",
        "items": [
            {
                "date": "2026-10-23",
                "title": "一键更新",
                "detail": "设置 → 版本与更新：检查到新版可「立即更新」——下载发行包、SHA256 校验、自动备份当前版本、停服务、覆盖程序、重启自检；data/ 与 .env 不动，失败可回退。装机版 1.3.1 用 Release 里的「光律-更新.command」双击升级。",
            },
            {
                "date": "2026-10-23",
                "title": "本机版本回退",
                "detail": "设置 → 版本与更新新增本机版本历史：可选择任意快照回退；回退只恢复程序与前端，不动 data/。",
            },
            {
                "date": "2026-10-23",
                "title": "外壳 v2 成为根入口",
                "detail": "根入口 / 默认终极形态 UI；旧壳用 ?shell=old，显式新版 ?shell=v2；项目壳同步 v2。",
            },
            {
                "date": "2026-10-23",
                "title": "三维空间名与家具",
                "detail": "空间名质心/锚点修正并缩小成小胶囊；CAD 标签恒定约 20px；多边形家具坐标单位修复，沙发等家具默认显示。",
            },
            {
                "date": "2026-10-23",
                "title": "施工令 v1 全量",
                "detail": "D-01~D-15：导出 500、B6 四接口、B1/B2 门禁、3D 三条 P0、B9 交付页、C9/C12/C1/C3、移动端与可读性；后端 verify 55/55。",
            },
            {
                "date": "2026-10-21",
                "title": "1.3.2 基线",
                "detail": "A1 白屏、A2 报价、A3 冻结后新建版本、B3 取消归档；本机单用户免登录部署。",
            },
        ],
    }
}


def _app_version() -> str:
    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _baseline() -> dict:
    try:
        data = json.loads(BUILD_BASELINE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _version_rows() -> list[dict]:
    rows: list[dict] = []
    if not VERSIONS.is_dir():
        return rows
    for p in VERSIONS.iterdir():
        if not p.is_dir():
            continue
        mf = p / "MANIFEST.json"
        tar = p / "code.tar.gz"
        if not mf.is_file() or not tar.is_file():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(m, dict):
            continue
        rows.append(
            {
                "id": str(m.get("id") or p.name),
                "createdAt": str(m.get("created_at") or ""),
                "version": str(m.get("version") or ""),
                "buildId": str(m.get("buildId") or ""),
                "asset": str(m.get("asset") or ""),
                "tag": str(m.get("tag") or ""),
                "note": str(m.get("note") or ""),
                "sizeBytes": int(m.get("size_bytes") or 0),
            }
        )
    rows.sort(key=lambda r: (r["createdAt"], r["id"]), reverse=True)
    cur = _baseline()
    for r in rows:
        if cur and r["buildId"] and r["buildId"] == str(cur.get("buildId") or "") and r["asset"] == str(cur.get("asset") or ""):
            r["current"] = True
            break
    return rows


@router.get("/release-notes")
def release_notes():
    version = _app_version()
    info = RELEASE_NOTES.get(version) or {}
    return {
        "version": version,
        "releasedAt": info.get("releasedAt", ""),
        "items": info.get("items", []),
    }


@router.get("/versions")
def app_versions():
    return {
        "current": {**_baseline(), "version": _app_version()},
        "versions": _version_rows(),
    }


@router.post("/versions/{vid}/rollback")
def rollback(vid: str, payload: dict = Body(default={})):
    global _rollback_started
    if not isinstance(payload, dict) or payload.get("confirm") is not True:
        raise HTTPException(400, "回退需要二次确认（confirm=true）")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", vid or ""):
        raise HTTPException(400, "版本 id 不合法")
    target = VERSIONS / vid
    if not (target / "MANIFEST.json").is_file() or not (target / "code.tar.gz").is_file():
        raise HTTPException(404, "本机没有这个版本快照")
    if not ROLLBACK_SCRIPT.is_file():
        raise HTTPException(500, "找不到版本回退脚本，请检查版本库")

    with _rollback_lock:
        if _rollback_started:
            raise HTTPException(409, "已有一次回退正在进行中")
        _rollback_started = True

    log_path = VERSION_STORE / "ui-rollback.log"
    # helper 独立会话：先留 3 秒把 HTTP 响应发出去，再停服务 / 恢复 / 重启。
    cmd = "sleep 3; exec /bin/bash %s --to %s --yes" % (
        shlex.quote(str(ROLLBACK_SCRIPT)),
        shlex.quote(vid),
    )
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "ab") as log:
            subprocess.Popen(
                ["/bin/bash", "-c", cmd],
                cwd=str(VERSION_STORE),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                close_fds=True,
            )
    except Exception as exc:  # noqa: BLE001
        with _rollback_lock:
            _rollback_started = False
        raise HTTPException(500, "回退进程启动失败：%s" % exc) from exc

    return {
        "ok": True,
        "target": vid,
        "message": "正在回退；服务会短暂重启，页面会自动重连。",
        "log": str(log_path),
    }


def register(app):
    app.include_router(router)
