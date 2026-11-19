"""Contact sheet for a logo concept.
usage: python sheet.py <tile.svg> <mark.svg> <out_sheet.png> [label] [small_tile.svg] [small_mark.svg]
 - tile.svg : full-colour app icon (rounded-square tile, viewBox 0 0 1024 1024 recommended)
 - mark.svg : header mark, monochrome via currentColor or explicit colours, viewBox 0 0 32 32
Shows the tile at 512/192/96/48/32/16 px on dark + light, the mark at 28px in a mock
dark header next to the word "Hunt", the mark at 16px (favicon), and a 66% Android
adaptive-icon safe-zone overlay.
"""
import sys, pathlib, tempfile
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from render import render

def load_font(sz):
    for f in [r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"]:
        try: return ImageFont.truetype(f, sz)
        except OSError: pass
    return ImageFont.load_default()

def main(tile_svg, mark_svg, out, label="", small_tile_svg=None, small_mark_svg=None):
    """small_tile_svg / small_mark_svg (optional): simplified variants used for the
    <=32px ladder entries and the 16px header slot (favicon / taskbar frames)."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sheet-"))
    tile = Image.open(render(tile_svg, tmp / "tile.png", 1024)).convert("RGBA")
    small_tile = Image.open(render(small_tile_svg, tmp / "tile_s.png", 1024)).convert("RGBA") if small_tile_svg else tile
    # render the mark on a page whose text colour is white so currentColor resolves to white
    mark_src = pathlib.Path(mark_svg).read_text(encoding="utf-8")
    if "currentColor" in mark_src:
        mark_src = mark_src.replace("currentColor", "#f4f1ea")
    mark_tmp = tmp / "mark.svg"; mark_tmp.write_text(mark_src, encoding="utf-8")
    mark = Image.open(render(mark_tmp, tmp / "mark.png", 1024)).convert("RGBA")
    small_mark = mark
    if small_mark_svg:
        sm_src = pathlib.Path(small_mark_svg).read_text(encoding="utf-8").replace("currentColor", "#f4f1ea")
        smp = tmp / "mark_s.svg"; smp.write_text(sm_src, encoding="utf-8")
        small_mark = Image.open(render(smp, tmp / "mark_s.png", 1024)).convert("RGBA")

    W, H = 1500, 900
    sheet = Image.new("RGBA", (W, H), (24, 25, 28, 255))
    d = ImageDraw.Draw(sheet)
    f_lab, f_big = load_font(18), load_font(30)
    d.text((24, 16), label or pathlib.Path(tile_svg).stem, fill=(235, 235, 235), font=f_big)
    # big tile + safe zone overlay
    big = tile.resize((512, 512), Image.LANCZOS)
    sheet.alpha_composite(big, (24, 70))
    ov = Image.new("RGBA", (512, 512), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
    r = 512 * 0.66 / 2; c = 256
    od.ellipse([c - r, c - r, c + r, c + r], outline=(255, 60, 60, 160), width=2)
    sheet.alpha_composite(ov, (24, 70))
    d.text((24, 590), "512px  (red circle = 66% Android adaptive safe zone)", fill=(170, 170, 170), font=f_lab)
    # size ladder on dark and light
    x0 = 580
    for row, bg in enumerate([(11, 12, 14, 255), (245, 245, 242, 255)]):
        y = 70 + row * 230
        d.rectangle([x0, y, W - 24, y + 210], fill=bg)
        x = x0 + 20
        for s in [192, 96, 48, 32, 16]:
            im = (small_tile if s <= 32 else tile).resize((s, s), Image.LANCZOS)
            sheet.alpha_composite(im, (x, y + 105 - s // 2))
            d.text((x, y + 185), f"{s}", fill=(140, 140, 140), font=f_lab)
            x += s + 40
    # mock header with mark at 28px + favicon 16px
    y = 540
    d.rectangle([x0, y, W - 24, y + 90], fill=(11, 12, 14, 255))
    m28 = mark.resize((28, 28), Image.LANCZOS)
    sheet.alpha_composite(m28, (x0 + 30, y + 31))
    d.text((x0 + 68, y + 30), "Hunt", fill=(255, 255, 255), font=load_font(22))
    m56 = mark.resize((56, 56), Image.LANCZOS)
    sheet.alpha_composite(m56, (x0 + 200, y + 17))
    m16 = small_mark.resize((16, 16), Image.LANCZOS)
    sheet.alpha_composite(m16, (x0 + 300, y + 37))
    d.text((x0 + 30, y + 95), "header mark 28px / 56px / 16px on #0b0c0e", fill=(170, 170, 170), font=f_lab)
    # mark on light at 28px
    d.rectangle([x0 + 520, y, W - 24, y + 90], fill=(245, 245, 242, 255))
    dark_src = pathlib.Path(mark_svg).read_text(encoding="utf-8").replace("currentColor", "#16181d")
    dm = tmp / "mark_dark.svg"; dm.write_text(dark_src, encoding="utf-8")
    md = Image.open(render(dm, tmp / "mark_dark.png", 512)).convert("RGBA").resize((28, 28), Image.LANCZOS)
    sheet.alpha_composite(md, (x0 + 550, y + 31))
    d.text((x0 + 590, y + 30), "Hunt", fill=(20, 20, 20), font=load_font(22))
    # 1024 mark large for inspection
    sheet.alpha_composite(mark.resize((200, 200), Image.LANCZOS), (x0 + 20, 660))
    d.text((x0 + 240, 750), "header mark (monochrome) at 200px", fill=(170, 170, 170), font=f_lab)
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)
    print(out)

if __name__ == "__main__":
    a = sys.argv
    main(a[1], a[2], a[3], a[4] if len(a) > 4 else "", a[5] if len(a) > 5 and a[5] else None, a[6] if len(a) > 6 and a[6] else None)
