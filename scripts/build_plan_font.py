"""维护者脚本：从 Debian 自带的 Droid / DejaVu 字体合成随包分发的绘图字体。

只有在装了 fonts-droid-fallback / fonts-dejavu-core 与 fontTools 的 Linux 上才需要跑；
普通使用者不用执行本脚本——GuanglvPlanSans.ttf 已经在 backend/fonts/ 里了。
"""
from pathlib import Path
import shutil
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

root = Path(__file__).resolve().parents[1]
out = root / "backend" / "fonts"
out.mkdir(exist_ok=True)
font = TTFont("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf")
latin = TTFont("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
scale_upem(latin, font["head"].unitsPerEm)
glyphs = latin.getGlyphSet()
order = list(font.getGlyphOrder())
for code, old_name in latin.getBestCmap().items():
    if not (0x20 <= code <= 0x24F or 0x2000 <= code <= 0x206F):
        continue
    name = f"gvLatin{code:04X}"
    recording = DecomposingRecordingPen(glyphs)
    glyphs[old_name].draw(recording)
    pen = TTGlyphPen(None)
    recording.replay(pen)
    font["glyf"][name] = pen.glyph()
    font["hmtx"].metrics[name] = latin["hmtx"].metrics[old_name]
    order.append(name)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[code] = name
font.setGlyphOrder(order)
for record in font["name"].names:
    if record.nameID in (1, 2, 3, 4, 6):
        name = "Regular" if record.nameID == 2 else "GuanglvPlanSans"
        record.string = name.encode(record.getEncoding(), errors="replace")
font.save(out / "GuanglvPlanSans.ttf")
shutil.copyfile("/usr/share/doc/fonts-dejavu-core/copyright", out / "DejaVu-LICENSE.txt")
(out / "Droid-LICENSE.txt").write_text(
    Path("/usr/share/doc/fonts-droid-fallback/copyright").read_text() + "\n" +
    Path("/usr/share/common-licenses/Apache-2.0").read_text())
(out / "README.md").write_text(
    "GuanglvPlanSans extends Droid Sans Fallback with Latin and punctuation outlines from DejaVu Sans.\n"
    "The font family is renamed GuanglvPlanSans. Added outlines are decomposed and scaled to Droid units per em.\n"
    "Original copyright and license notices are included alongside.\n")
print(out / "GuanglvPlanSans.ttf")
