#!/usr/bin/env python3
"""光律 GUANGLV Workbench · 版本号守卫

规则见 ``docs/版本号规则.md``。常用：

  python3 scripts/version_guard.py --check                 # 版本源是否一致（打包/发版前）
  python3 scripts/version_guard.py --check-bump [--base v1.3.3]
                                                          # 与上一个已发布 tag 比，递增是否合法
  python3 scripts/version_guard.py --check-tag v1.3.4      # tag 格式 / annotated / 指向 HEAD / == VERSION
  python3 scripts/version_guard.py --bump patch            # 只改 VERSION + README + frontend/package.json
  python3 scripts/version_guard.py --baseline              # 前端构建后重写 build-baseline.json

``--check`` 只做静态一致性，不判断「这次该 minor 还是 patch」；语义由发版人按规则表签字。
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SEMVER_RE = re.compile(r"^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$")
TAG_RE = re.compile(r"^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$")
README_VERSION_RE = re.compile(r"当前版本\s*\*{0,2}v?([0-9]+\.[0-9]+\.[0-9]+)")
DIST_ASSET_RE = re.compile(r"/assets/([A-Za-z0-9._-]+\.js)")

POLICY_DOC = "docs/版本号规则.md"
RELEASE_NOTES_FILE = "backend/app_versions.py"
README_FILE = "README.md"
VERSION_FILE = "VERSION"
PACKAGE_FILE = "frontend/package.json"
PACKAGE_LOCK_FILE = "frontend/package-lock.json"
BASELINE_FILE = "build-baseline.json"
DIST_INDEX = "frontend/dist/index.html"
CATEGORIES = {"fix", "feat", "breaking"}
# 规则从 1.3.4 起生效；1.3.2 / 1.3.3 是历史版本，不回填 category。
CATEGORY_START = (1, 3, 4)


class VersionError(ValueError):
    """版本号不符合规则。"""


def read_version(root: Path) -> str:
    try:
        return (root / VERSION_FILE).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise VersionError(f"读不到 {root / VERSION_FILE}：{exc}") from exc


def parse_semver(value: str, where: str = "版本号") -> tuple:
    text = (value or "").strip()
    match = SEMVER_RE.match(text)
    if not match:
        raise VersionError(
            f"{where} {text!r} 不合法：必须是纯三段数字 X.Y.Z（如 1.3.4），"
            "不能带 v、不能有前导零、不能有 -beta/+build 后缀、不能是两段或四段。"
        )
    return tuple(int(part) for part in match.groups())


def fmt(version: tuple) -> str:
    return ".".join(str(part) for part in version)


def read_readme_version(root: Path) -> str:
    try:
        text = (root / README_FILE).read_text(encoding="utf-8")
    except OSError as exc:
        raise VersionError(f"读不到 {root / README_FILE}：{exc}") from exc
    match = README_VERSION_RE.search(text)
    if not match:
        raise VersionError(f"{README_FILE} 里找不到「当前版本 vX.Y.Z」")
    return match.group(1)


def read_release_notes(root: Path) -> dict:
    path = root / RELEASE_NOTES_FILE
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError) as exc:
        raise VersionError(f"读不了 {path}：{exc}") from exc
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "RELEASE_NOTES" for t in node.targets):
            continue
        try:
            value = ast.literal_eval(node.value)
        except ValueError as exc:
            raise VersionError(f"{path} 的 RELEASE_NOTES 不是字面量字典：{exc}") from exc
        if not isinstance(value, dict):
            raise VersionError(f"{path} 的 RELEASE_NOTES 不是字典")
        return value
    raise VersionError(f"{path} 里找不到 RELEASE_NOTES 定义")


def read_package_version(root: Path) -> str | None:
    path = root / PACKAGE_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise VersionError(f"读不了 {path}：{exc}") from exc
    return str(data.get("version") or "")


def fingerprint(root: Path) -> dict:
    """从 frontend/dist 算构建指纹：buildId / asset / asset_sha256。"""
    index = root / DIST_INDEX
    try:
        markup = index.read_text(encoding="utf-8")
    except OSError as exc:
        raise VersionError(f"读不到 {index}；先在 frontend/ 跑 npm run build：{exc}") from exc
    match = DIST_ASSET_RE.search(markup)
    if not match:
        raise VersionError(f"{index} 里找不到 /assets/index-*.js")
    asset = match.group(1)
    asset_path = root / "frontend" / "dist" / "assets" / asset
    try:
        asset_bytes = asset_path.read_bytes()
    except OSError as exc:
        raise VersionError(f"读不到 {asset_path}：{exc}") from exc
    return {
        "buildId": hashlib.sha1(markup.encode("utf-8")).hexdigest()[:12],
        "asset": asset,
        "asset_sha256": hashlib.sha256(asset_bytes).hexdigest(),
    }


def read_baseline(root: Path) -> dict:
    path = root / BASELINE_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise VersionError(f"读不到 {path}：{exc}") from exc
    except ValueError as exc:
        raise VersionError(f"{path} 不是合法 JSON：{exc}") from exc
    return data if isinstance(data, dict) else {}


def check_release_files(root: Path = ROOT, strict_build: bool = False) -> tuple:
    """发版前文件一致性检查，返回 (problems, warnings)。

    版本号 / README / package.json / RELEASE_NOTES / 规则文件 缺失一律算 problem；
    build-baseline 与 dist 的配对默认只告警（开发中重建前端很常见），
    ``strict_build=True``（打包与 tag CI）时才算 problem。
    """
    problems: list = []
    warnings: list = []
    try:
        version_text = read_version(root)
        current = parse_semver(version_text, "VERSION")
    except VersionError as exc:
        return [str(exc)], []

    def build_issue(message: str) -> None:
        (problems if strict_build else warnings).append(message)

    if is_git_repo(root):
        head_version = (_git(root, "show", "HEAD:VERSION") or "").strip()
        if head_version and head_version != version_text:
            warnings.append(
                f"工作区 VERSION {version_text} 还没提交（HEAD 是 {head_version}）；"
                "tag 前必须先提交，否则 tag 会指向旧版本。"
            )

    try:
        readme_version = read_readme_version(root)
        if readme_version != version_text:
            problems.append(
                f"README.md 的「当前版本 v{readme_version}」与 VERSION {version_text} 不一致；"
                f"发版前改成 v{version_text}。"
            )
    except VersionError as exc:
        problems.append(str(exc))

    try:
        package_version = read_package_version(root)
        if package_version is not None and package_version != version_text:
            problems.append(
                f"{PACKAGE_FILE} 的 version {package_version or '（空）'} 与 VERSION {version_text} 不一致。"
            )
    except VersionError as exc:
        problems.append(str(exc))

    lock_path = root / PACKAGE_LOCK_FILE
    if lock_path.is_file():
        try:
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"读不了 {PACKAGE_LOCK_FILE}：{exc}")
        else:
            lock_versions = [str(lock.get("version") or "")]
            packages = lock.get("packages")
            if isinstance(packages, dict) and isinstance(packages.get(""), dict):
                lock_versions.append(str(packages[""].get("version") or ""))
            for lock_version in lock_versions:
                if lock_version and lock_version != version_text:
                    problems.append(
                        f"{PACKAGE_LOCK_FILE} 的根版本 {lock_version} 与 VERSION {version_text} 不一致。"
                    )

    try:
        notes = read_release_notes(root)
    except VersionError as exc:
        problems.append(str(exc))
        notes = {}
    entry = notes.get(version_text)
    if not isinstance(entry, dict):
        problems.append(
            f"{RELEASE_NOTES_FILE} 的 RELEASE_NOTES 里没有 {version_text} 这一条；"
            "工作台「本版更新」会显示未登记。"
        )
    else:
        items = entry.get("items") or []
        if not isinstance(items, list) or not items:
            problems.append(f"RELEASE_NOTES[{version_text}].items 不能为空。")
        elif current >= CATEGORY_START:
            for pos, item in enumerate(items, 1):
                category = item.get("category") if isinstance(item, dict) else None
                if category not in CATEGORIES:
                    problems.append(
                        f"RELEASE_NOTES[{version_text}] 第 {pos} 条缺少 category（fix / feat / breaking）。"
                    )

    if not (root / POLICY_DOC).is_file():
        problems.append(f"缺少版本规则文件 {POLICY_DOC}。")

    try:
        baseline = read_baseline(root)
    except VersionError as exc:
        problems.append(str(exc))
        baseline = {}
    if baseline:
        if str(baseline.get("version") or "") != version_text:
            build_issue(
                f"{BASELINE_FILE} 的 version {baseline.get('version') or '（空）'} 与 VERSION {version_text} 不一致；"
                "改号后要重新构建前端并跑 --baseline。"
            )
        try:
            actual = fingerprint(root)
        except VersionError as exc:
            build_issue(str(exc))
        else:
            for key in ("buildId", "asset", "asset_sha256"):
                expected = str(baseline.get(key) or "")
                if expected and expected != actual[key]:
                    build_issue(
                        f"{BASELINE_FILE} 的 {key} 与 frontend/dist 不一致（基线 {expected} / 实际 {actual[key]}）。"
                    )
            asset_path = root / "frontend" / "dist" / "assets" / actual["asset"]
            if not asset_path.is_file():
                build_issue(f"frontend/dist/assets 里没有 {actual['asset']}。")
            built_at = str(baseline.get("built_at") or "")
            if built_at:
                try:
                    built_ts = datetime.strptime(built_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
                except ValueError:
                    built_ts = 0
                src = root / "frontend" / "src"
                # git clone/checkout 会把所有文件 mtime 刷新成检出时间，这个告警只对工作目录有意义。
                if built_ts and src.is_dir() and not is_git_repo(root):
                    newer = [p for p in src.rglob("*") if p.is_file() and p.stat().st_mtime > built_ts + 5]
                    if newer:
                        warnings.append(
                            f"frontend/src 有 {len(newer)} 个文件晚于 build-baseline.built_at；"
                            "可能忘了 npm run build。"
                        )

    release_json = root / "dist-release" / "release.json"
    if release_json.is_file():
        try:
            data = json.loads(release_json.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            build_issue(f"dist-release/release.json 读不了：{exc}")
        else:
            built = str(data.get("version") or "")
            if built and built != version_text:
                # 旧构建产物是正常现象，build_release.py 会覆盖；只提醒不拦。
                warnings.append(
                    f"dist-release/release.json 还是旧版 v{built}，"
                    f"本次 build_release.py 会重建为 v{version_text}。"
                )
            elif built == version_text:
                expected_tag = f"v{version_text}"
                if str(data.get("tag") or "") != expected_tag:
                    build_issue(f"release.json 的 tag 不是 {expected_tag}。")
                expected_pkg = f"guanglv-workbench-{version_text}.tar.gz"
                if str(data.get("package") or "") != expected_pkg:
                    build_issue(f"release.json 的 package 不是 {expected_pkg}。")

    return problems, warnings


def _git(root: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def is_git_repo(root: Path) -> bool:
    out = _git(root, "rev-parse", "--is-inside-work-tree")
    return bool(out and out.strip() == "true")


def git_tags(root: Path) -> dict:
    """{版本元组: tag 名}；只认严格的 vX.Y.Z。"""
    out = _git(root, "tag", "--list", "v*")
    tags: dict = {}
    if not out:
        return tags
    for name in out.splitlines():
        name = name.strip()
        match = TAG_RE.match(name)
        if match:
            tags[tuple(int(p) for p in match.groups())] = name
    return tags


def previous_version(root: Path, current: tuple, base: str | None = None) -> tuple:
    if base:
        text = base.strip()
        if text.lower().startswith("v"):
            text = text[1:]
        return parse_semver(text, "--base")
    if not is_git_repo(root):
        raise VersionError(
            "当前目录不是 git 仓库，无法自动取上一个 tag；请用 --base vX.Y.Z 指定。"
        )
    tags = git_tags(root)
    older = [version for version in tags if version < current]
    if not older:
        raise VersionError("找不到比当前 VERSION 更小的 vX.Y.Z tag，无法判断 bump 是否合法。")
    return max(older)


def bump_kind(old: tuple, new: tuple) -> str:
    if new <= old:
        raise VersionError(f"新版本 {fmt(new)} 必须大于旧版本 {fmt(old)}，不能回退或重号。")
    if new[0] == old[0] + 1 and new[1] == 0 and new[2] == 0:
        return "major"
    if new[0] == old[0] and new[1] == old[1] + 1 and new[2] == 0:
        return "minor"
    if new[0] == old[0] and new[1] == old[1] and new[2] > old[2]:
        if new[2] != old[2] + 1:
            print(f"[警告] patch 跳号：v{fmt(old)} → v{fmt(new)}；Release 正文必须写跳号原因。")
        return "patch"
    if new[0] == old[0] and new[1] > old[1] and new[2] == 0:
        print(f"[警告] minor 跳号：v{fmt(old)} → v{fmt(new)}；Release 正文必须写跳号原因。")
        return "minor"
    raise VersionError(
        f"不允许从 {fmt(old)} 跳到 {fmt(new)}：只能 +1 一个号段并把低位置零"
        f"（major {old[0] + 1}.0.0 / minor {old[0]}.{old[1] + 1}.0 / patch {old[0]}.{old[1]}.{old[2] + 1}），"
        "也不能跨段乱跳。"
    )


def check_categories(kind: str, notes: dict, version_text: str) -> None:
    if parse_semver(version_text, "VERSION") < CATEGORY_START:
        return
    entry = notes.get(version_text)
    items = entry.get("items") if isinstance(entry, dict) else None
    if not isinstance(items, list) or not items:
        raise VersionError(f"RELEASE_NOTES[{version_text}] 没有 items。")
    categories = []
    for pos, item in enumerate(items, 1):
        category = item.get("category") if isinstance(item, dict) else None
        if category not in CATEGORIES:
            raise VersionError(
                f"RELEASE_NOTES[{version_text}] 第 {pos} 条缺少 category（fix / feat / breaking）。"
            )
        categories.append(category)
    if kind == "patch" and any(c in ("feat", "breaking") for c in categories):
        raise VersionError(
            f"版本按 patch 发（{version_text}），但 RELEASE_NOTES 里有 feat/breaking；"
            "有新功能就升 minor，有不兼容就升 major。"
        )
    if kind == "minor" and any(c == "breaking" for c in categories):
        raise VersionError(
            f"版本按 minor 发（{version_text}），但 RELEASE_NOTES 里有 breaking；应升 major。"
        )


def check_bump(root: Path, base: str | None = None, allow_same: bool = False) -> str:
    current_text = read_version(root)
    current = parse_semver(current_text, "VERSION")
    previous = previous_version(root, current, base)
    if previous == current:
        if allow_same:
            print(f"版本未变化：v{current_text}（允许：刚打完 tag 的 main）")
            return "same"
        raise VersionError(f"VERSION 仍是 v{current_text}，没有 bump；发新版本前必须先升版本号。")
    if is_git_repo(root):
        higher = sorted(version for version in git_tags(root) if version > current)
        if higher:
            raise VersionError(
                f"远端/本地已有更高版本 tag v{fmt(higher[-1])}，不能再补发 v{current_text}；"
                "latest release 按发布时间取，补发旧号会让新版本对用户隐形。"
            )
    kind = bump_kind(previous, current)
    check_categories(kind, read_release_notes(root), current_text)
    print(f"版本递增合法：v{fmt(previous)} → v{current_text}（{kind}）")
    return kind


def check_tag(root: Path, tag: str) -> None:
    match = TAG_RE.match(tag or "")
    if not match:
        raise VersionError(f"tag {tag!r} 不合法：必须是 vX.Y.Z（如 v1.3.4）。")
    tag_version = fmt(tuple(int(p) for p in match.groups()))
    current = read_version(root)
    if tag_version != current:
        raise VersionError(f"tag {tag} 与 VERSION {current} 不一致；tag 必须等于 v + VERSION。")
    if is_git_repo(root):
        kind = _git(root, "cat-file", "-t", f"refs/tags/{tag}") or _git(root, "cat-file", "-t", tag)
        if kind is None:
            raise VersionError(
                f"本地找不到 {tag} 的 tag 对象；先 git tag -a，"
                "CI 要 fetch-depth: 0 + fetch-tags: true。"
            )
        if kind.strip() != "tag":
            raise VersionError(
                f"tag {tag} 是 lightweight tag；发版必须用 annotated tag："
                f'git tag -a {tag} -m "光律 v{tag_version}"'
            )
        head = (_git(root, "rev-parse", "HEAD") or "").strip()
        tagged = (_git(root, "rev-list", "-n", "1", tag) or "").strip()
        if head and tagged and head != tagged:
            raise VersionError(f"tag {tag} 不在当前 HEAD 上；先确认提交，再打 tag。")
        head_version = (_git(root, "show", "HEAD:VERSION") or "").strip()
        if head_version and head_version != current:
            raise VersionError(
                f"HEAD 里的 VERSION 是 {head_version}，工作区是 {current}；先把版本号提交再打 tag。"
            )
    print(f"tag 合法：{tag} == VERSION {current}")


def bump(root: Path, part: str) -> None:
    old_text = read_version(root)
    old = parse_semver(old_text, "VERSION")
    if part == "major":
        new = (old[0] + 1, 0, 0)
    elif part == "minor":
        new = (old[0], old[1] + 1, 0)
    else:
        new = (old[0], old[1], old[2] + 1)
    new_text = fmt(new)
    (root / VERSION_FILE).write_text(new_text + "\n", encoding="utf-8")

    readme = root / README_FILE
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        updated, count = README_VERSION_RE.subn(f"当前版本 v{new_text}", text, count=1)
        if count:
            readme.write_text(updated, encoding="utf-8")

    package = root / PACKAGE_FILE
    if package.is_file():
        data = json.loads(package.read_text(encoding="utf-8"))
        data["version"] = new_text
        package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lock = root / PACKAGE_LOCK_FILE
    if lock.is_file():
        text = lock.read_text(encoding="utf-8")
        # 只改根对象和 packages[""] 的版本，依赖自身的 1.3.3 不能碰。
        text = text.replace(f'"version": "{old_text}"', f'"version": "{new_text}"', 2)
        lock.write_text(text, encoding="utf-8")

    print(f"VERSION：{old_text} → {new_text}（{part}）")
    print("README「当前版本」与 frontend/package.json 已同步。")
    print("还要做：")
    print(f"  1) 在 {RELEASE_NOTES_FILE} 的 RELEASE_NOTES 补 {new_text}，每条写 category；")
    print("  2) cd frontend && npm run build（刷新 dist），再跑 --baseline；")
    print("  3) 写 Release 说明（模板见 docs/版本号规则.md），再 --check / --check-bump。")


def write_baseline(root: Path) -> None:
    version_text = read_version(root)
    actual = fingerprint(root)
    source = None
    if is_git_repo(root):
        source = (_git(root, "rev-parse", "--short", "HEAD") or "").strip() or None
    if not source:
        source = "direct-edit-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    data = {
        "version": version_text,
        "buildId": actual["buildId"],
        "asset": actual["asset"],
        "asset_sha256": actual["asset_sha256"],
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_commit": source,
    }
    (root / BASELINE_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已重写 {BASELINE_FILE}：v{version_text} / {actual['buildId']} / {actual['asset']}")


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="光律版本号守卫（规则见 docs/版本号规则.md）")
    parser.add_argument("--root", default=str(ROOT), help="项目根目录（默认脚本上一级）")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="检查版本源一致性（默认）")
    group.add_argument("--check-bump", action="store_true", help="检查与上一个已发布 tag 的递增是否合法")
    group.add_argument("--check-tag", metavar="TAG", help="检查 tag 格式 / annotated / 指向 HEAD / 与 VERSION 一致")
    group.add_argument("--bump", choices=("major", "minor", "patch"), help="升级 VERSION（同步 README、package.json）")
    group.add_argument("--baseline", action="store_true", help="前端构建后重写 build-baseline.json")
    parser.add_argument("--base", metavar="vX.Y.Z", help="--check-bump 的基准版本（非 git 目录时必填）")
    parser.add_argument("--allow-same", action="store_true", help="--check-bump 允许版本未变化（刚打完 tag）")
    parser.add_argument("--strict", action="store_true", help="--check 把 build-baseline/dist 不一致也算失败（打包/发版用）")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    try:
        if args.check_tag:
            check_tag(root, args.check_tag)
        elif args.check_bump:
            check_bump(root, args.base, args.allow_same)
        elif args.bump:
            bump(root, args.bump)
        elif args.baseline:
            write_baseline(root)
        else:
            problems, warnings = check_release_files(root, strict_build=args.strict)
            for item in warnings:
                print(f"[警告] {item}", file=sys.stderr)
            if problems:
                print("版本号检查未通过：", file=sys.stderr)
                for item in problems:
                    print(f"  - {item}", file=sys.stderr)
                return 1
            suffix = "（有警告）" if warnings else ""
            print(f"版本号检查通过：v{read_version(root)}{suffix}")
    except VersionError as exc:
        print(f"版本号检查未通过：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
