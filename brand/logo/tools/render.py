"""Render an SVG to a transparent PNG with headless Chrome.
usage: python render.py <in.svg> <out.png> [size=1024]
"""
import os, subprocess, sys, tempfile, pathlib, shutil

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

def render(svg_path, out_png, size=1024):
    svg_path = pathlib.Path(svg_path).resolve()
    out_png = pathlib.Path(out_png).resolve()
    out_png.parent.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix="logo-render-"))
    try:
        html = work / "wrap.html"
        html.write_text(
            "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}"
            f"img{{display:block;width:{size}px;height:{size}px}}</style></head>"
            f"<body><img src=\"{svg_path.as_uri()}\"></body></html>", encoding="utf-8")
        cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
               "--no-default-browser-check", "--allow-file-access-from-files",
               f"--user-data-dir={work / 'profile'}", "--default-background-color=00000000",
               "--force-device-scale-factor=1", f"--window-size={size},{size}",
               f"--screenshot={out_png}", html.as_uri()]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if not out_png.exists():
            raise SystemExit(f"render failed for {svg_path}:\n{r.stderr[-2000:]}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return out_png

if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1024)
    print(sys.argv[2])
