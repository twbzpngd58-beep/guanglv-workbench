"""Create a portable source bundle, excluding local data, secrets and dependencies."""

from pathlib import Path
import zipfile, hashlib

root = Path(__file__).resolve().parents[1]
out = root / "deliverables/guanglv-workbench.zip"
allowed = []
for name in [
    "README.md",
    "TEST_REPORT.md",
    "VERSION",
    "LICENSE",
    "start.py",
    "start.sh",
    "start.bat",
    "requirements.txt",
    "requirements.lock.txt",
    ".env.example",
    ".gitignore",
]:
    allowed.append(root / name)
for folder in ["backend", "frontend", "tests", "scripts", "docs"]:
    for path in (root / folder).rglob("*"):
        if not path.is_file():
            continue
        if any(
            x in path.parts
            for x in [
                "node_modules",
                "__pycache__",
                "test-results",
                "playwright-report",
            ]
        ):
            continue
        if path.suffix == ".tsbuildinfo" or path.suffix == ".bak" or path.name.endswith(".bak"):
            continue
        if path.name in {".DS_Store", "Thumbs.db"}:
            continue
        allowed.append(path)
for pattern in [
    "*.png",
    "*.xml",
    "*.log",
    "*.xlsx",
    "restart-persistence.txt",
    "release-smoke-test.txt",
]:
    allowed.extend((root / "deliverables").glob(pattern))
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=8) as z:
    for path in sorted(set(allowed)):
        if path.exists():
            z.write(path, Path("guanglv-workbench") / path.relative_to(root))
checksum = hashlib.sha256(out.read_bytes()).hexdigest()
(root / "deliverables/guanglv-workbench.sha256").write_text(
    f"{checksum}  {out.name}\n"
)
print(f"{out}\n{out.stat().st_size:,} bytes · {len(allowed)} files\nSHA-256 {checksum}")
