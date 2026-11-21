"""Export a finished Hunt logo into every asset the app uses.

usage: python export.py <concept-prefix> <out-root>
  <concept-prefix>  e.g. .../concepts/QHF-final  (expects -tile.svg, -tile-small.svg,
                    -mark.svg, -mark-small.svg, -mark-mono.svg next to it)
  <out-root>        project root (or a scratch dir for a dry run)

Writes (relative to out-root):
  public/hunt-logo.png                         512px PWA / apple-touch icon (full tile)
  src/app/icon.svg                             favicon (small-size tile, scalable)
  HUNT.ico, HUNT-Orbital.ico                   Windows shortcut icons: 16/24/32/48 from the
                                               small tile, 64/128/256 from the full tile
  android-app/app/src/main/res/
    mipmap-<dpi>/ic_launcher.png               legacy launcher icon (full tile)
    mipmap-<dpi>/ic_launcher_foreground.png    adaptive foreground (mark only, safe-zone scaled)
    mipmap-<dpi>/ic_launcher_monochrome.png    Android 13+ themed-icon layer
    drawable/ic_launcher_background.xml        adaptive background (the tile's gradient)
    mipmap-anydpi-v26/ic_launcher.xml          adaptive-icon definition
  _logo-export/HuntLogo.paths.txt              the mark's SVG body for the React component
"""
import pathlib
import re
import shutil
import struct
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from render import render  # noqa: E402

DPI = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SAFE_DIAMETER_TILE = 676.0          # tile units: the 66% circle every concept was designed inside
ADAPTIVE_LAYER_DP, ADAPTIVE_SAFE_DP = 108.0, 66.0


def svg_inner(svg_text):
    """Return (defs_and_shapes_without_background, viewBox) of a tile SVG."""
    body = re.sub(r"^.*?<svg[^>]*>", "", svg_text, count=1, flags=re.S)
    body = re.sub(r"</svg>\s*$", "", body.strip(), flags=re.S)
    return body


def strip_background(tile_svg):
    """Remove the full-bleed background rect(s) (rx=230 tile + hairline border) from a tile."""
    out = []
    for line in svg_inner(tile_svg).splitlines():
        if re.search(r"<rect[^>]*(rx=\"2(30|28\.5)\"|width=\"10(24|21)\")", line):
            continue
        out.append(line)
    return "\n".join(out)


def foreground_svg(tile_svg, color_override=None):
    """Adaptive-icon foreground: the tile's mark, scaled so the design's 66% safe circle
    maps onto Android's 66dp safe zone of the 108dp layer, on a transparent canvas."""
    body = strip_background(tile_svg)
    if color_override:
        body = re.sub(r'fill="(?!none)[^"]*"', f'fill="{color_override}"', body)
        body = re.sub(r'stroke="(?!none)[^"]*"', f'stroke="{color_override}"', body)
    w = SAFE_DIAMETER_TILE * ADAPTIVE_LAYER_DP / ADAPTIVE_SAFE_DP
    x0 = 512 - w / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
            f'viewBox="{x0:.2f} {x0:.2f} {w:.2f} {w:.2f}">{body}</svg>')


def _rgba_to_dib(im):
    """32-bit BGRA bottom-up BITMAPINFOHEADER DIB + 1-bit AND mask for Win32 ICO compatibility."""
    w, h = im.size
    rgba = im.tobytes("raw", "RGBA")
    xor_buf = bytearray(w * h * 4)
    mask_row = ((w + 31) // 32) * 4
    and_buf = bytearray(mask_row * h)
    for y in range(h):
        sy = h - 1 - y
        for x in range(w):
            s = (sy * w + x) * 4
            d = (y * w + x) * 4
            r, g, b, a = rgba[s], rgba[s + 1], rgba[s + 2], rgba[s + 3]
            xor_buf[d:d + 4] = bytes((b, g, r, a))
            if a == 0:
                and_buf[y * mask_row + (x >> 3)] |= 0x80 >> (x & 7)
    hdr = struct.pack("<IIIHHIIIIII", 40, w, h * 2, 1, 32, 0, len(xor_buf) + len(and_buf), 0, 0, 0, 0)
    return hdr + bytes(xor_buf) + bytes(and_buf)


def write_ico(path, frames):
    """frames: list of PIL RGBA images (distinct sizes). Uses DIB for <256px and PNG for 256px."""
    blobs = []
    for im in frames:
        if im.size[0] >= 256:
            tmp = pathlib.Path(tempfile.mkdtemp()) / "f.png"
            im.save(tmp, format="PNG")
            blobs.append((im.size[0], tmp.read_bytes()))
        else:
            blobs.append((im.size[0], _rgba_to_dib(im)))
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, data = b"", b""
    for size, blob in blobs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    pathlib.Path(path).write_bytes(header + entries + data)


def main(prefix, out_root):
    prefix, out = pathlib.Path(prefix), pathlib.Path(out_root)
    f = {k: pathlib.Path(f"{prefix}-{k}.svg") for k in ("tile", "tile-small", "mark", "mark-small", "mark-mono")}
    for k, p in f.items():
        if not p.exists():
            raise SystemExit(f"missing {k}: {p}")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="logo-export-"))
    tile = Image.open(render(f["tile"], tmp / "tile.png", 1024)).convert("RGBA")
    tile_s = Image.open(render(f["tile-small"], tmp / "tile_s.png", 1024)).convert("RGBA")
    tile_svg = f["tile"].read_text(encoding="utf-8")

    # 1. PWA / apple-touch icon
    (out / "public").mkdir(parents=True, exist_ok=True)
    tile.resize((512, 512), Image.LANCZOS).save(out / "public" / "hunt-logo.png", optimize=True)

    # 2. favicon (scalable small-size tile)
    (out / "src" / "app").mkdir(parents=True, exist_ok=True)
    fav = f["tile-small"].read_text(encoding="utf-8")
    fav = re.sub(r'(<svg[^>]*?)\swidth="\d+"', r'\1 width="64"', fav, count=1)
    fav = re.sub(r'(<svg[^>]*?)\sheight="\d+"', r'\1 height="64"', fav, count=1)
    (out / "src" / "app" / "icon.svg").write_text(fav, encoding="utf-8")

    # 3. Windows .ico (both names; HUNT.lnk points at HUNT-Orbital.ico)
    # The perched falcon turns the h into a "k" at 48px and below, so those frames use the
    # falcon-less small tile; 64px and up show the full mark.
    frames = [tile_s.resize((s, s), Image.LANCZOS) for s in (16, 24, 32, 48)] + \
             [tile.resize((s, s), Image.LANCZOS) for s in (64, 128, 256)]
    for name in ("HUNT.ico", "HUNT-Orbital.ico", "HUNT-Falcon.ico", "public/favicon.ico"):
        write_ico(out / name, frames)

    # 4. Android launcher icons
    res = out / "android-app" / "app" / "src" / "main" / "res"
    fg_svg, mono_svg = tmp / "fg.svg", tmp / "mono.svg"
    fg_svg.write_text(foreground_svg(tile_svg), encoding="utf-8")
    fg = Image.open(render(fg_svg, tmp / "fg.png", 1024)).convert("RGBA")
    # Themed icons are tinted by the launcher, so the layer is pure white on transparent.
    # Render the single-colour mark large, then fit its ink bounding box exactly onto the
    # bounding box of the colour foreground's ink, so both layers line up pixel for pixel.
    mono_svg.write_text(f["mark-mono"].read_text(encoding="utf-8").replace("currentColor", "#ffffff"),
                        encoding="utf-8")
    mono_src = Image.open(render(mono_svg, tmp / "mono_src.png", 1024)).convert("RGBA")
    fg_box, mono_box = fg.getchannel("A").getbbox(), mono_src.getchannel("A").getbbox()
    glyph = mono_src.crop(mono_box)
    tw, th = fg_box[2] - fg_box[0], fg_box[3] - fg_box[1]
    scale = min(tw / glyph.width, th / glyph.height)
    glyph = glyph.resize((max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))), Image.LANCZOS)
    mono = Image.new("RGBA", fg.size, (0, 0, 0, 0))
    mono.alpha_composite(glyph, (fg_box[0] + (tw - glyph.width) // 2, fg_box[1] + (th - glyph.height) // 2))
    for dpi, k in DPI.items():
        d = res / f"mipmap-{dpi}"
        d.mkdir(parents=True, exist_ok=True)
        tile.resize((round(48 * k), round(48 * k)), Image.LANCZOS).save(d / "ic_launcher.png", optimize=True)
        layer = round(ADAPTIVE_LAYER_DP * k)
        fg.resize((layer, layer), Image.LANCZOS).save(d / "ic_launcher_foreground.png", optimize=True)
        mono.resize((layer, layer), Image.LANCZOS).save(d / "ic_launcher_monochrome.png", optimize=True)
    (res / "drawable").mkdir(parents=True, exist_ok=True)
    (res / "drawable" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Adaptive launcher icon background: the Hunt tile gradient (top #15171c -> bottom #0b0c0e). -->\n'
        '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n'
        '    <gradient android:angle="270" android:startColor="#FF15171C" android:endColor="#FF0B0C0E" />\n'
        '</shape>\n', encoding="utf-8")
    (res / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
    (res / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@drawable/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />\n'
        '</adaptive-icon>\n', encoding="utf-8")

    # 5. the mark body for the React header component (written next to the export, not into src/)
    (out / "_logo-export").mkdir(parents=True, exist_ok=True)
    (out / "_logo-export" / "HuntLogo.paths.txt").write_text(svg_inner(f["mark"].read_text(encoding="utf-8")),
                                                              encoding="utf-8")
    # previews of the adaptive icon under circle and squircle masks for a visual check
    bg = Image.new("RGBA", fg.size, (16, 18, 22, 255))
    comp = Image.alpha_composite(bg, fg)
    prev = Image.new("RGBA", (2 * 300 + 60, 340), (30, 31, 35, 255))
    for i, shape in enumerate(("circle", "squircle")):
        mask = Image.new("L", (1024, 1024), 0)
        from PIL import ImageDraw
        dr = ImageDraw.Draw(mask)
        inset = int(1024 * (ADAPTIVE_LAYER_DP - 72) / 2 / ADAPTIVE_LAYER_DP)   # visible 72dp viewport
        box = [inset, inset, 1024 - inset, 1024 - inset]
        if shape == "circle":
            dr.ellipse(box, fill=255)
        else:
            dr.rounded_rectangle(box, radius=int((1024 - 2 * inset) * 0.3), fill=255)
        icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        icon.paste(comp, (0, 0), mask)
        icon = icon.crop(box).resize((300, 300), Image.LANCZOS)
        prev.alpha_composite(icon, (20 + i * 320, 20))
    prev.convert("RGB").save(out / "_logo-export" / "adaptive-preview.png")
    shutil.rmtree(tmp, ignore_errors=True)
    print("exported to", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
