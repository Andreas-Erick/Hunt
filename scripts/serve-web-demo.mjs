// Serves the exported browser demo (out/) under its sub-path, the way a static host would:
//
//   node scripts/serve-web-demo.mjs [--port 4173]
//
//   http://localhost:4173/demos/hunt/         the demo itself
//   http://localhost:4173/                    a host page that embeds it in an iframe, with
//                                             width buttons from 360 px to 1280 px
//
// HUNT_WEB_BASE_PATH must match the one the demo was built with (default /demos/hunt).
// Preview only: no caching, no compression, and nothing outside out/ is ever served.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "out");
const BASE = (process.env.HUNT_WEB_BASE_PATH ?? "/demos/hunt").replace(/\/+$/, "");
const portFlag = process.argv.indexOf("--port");
const PORT = Number(portFlag > 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunt demo host</title>
<style>
  body{margin:0;font:14px system-ui,sans-serif;background:#f4f4f5;color:#18181b}
  header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 16px}
  button{min-height:36px;padding:0 12px;border:1px solid #d4d4d8;border-radius:8px;background:#fff;cursor:pointer}
  iframe{display:block;margin:0 auto 24px;border:1px solid #d4d4d8;border-radius:12px;background:#0b0c0e;height:760px;max-width:calc(100% - 32px)}
</style></head>
<body>
<header><strong>Embedded demo</strong>
  ${[360, 768, 1024, 1280].map((w) => `<button type="button" data-w="${w}">${w}px</button>`).join("")}
</header>
<iframe id="demo" title="Hunt live demo" src="${BASE}/" width="1280" loading="eager"></iframe>
<script>
  for (const b of document.querySelectorAll("button[data-w]"))
    b.onclick = () => { document.getElementById("demo").width = b.dataset.w; };
</script>
</body></html>`;

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/** The file under out/ a request path names, or null when it names nothing (or escapes out/). */
function resolveFile(urlPath) {
  const rel = decodeURIComponent(urlPath.slice(BASE.length)) || "/";
  const candidate = path.normalize(path.join(OUT_DIR, rel));
  if (candidate !== OUT_DIR && !candidate.startsWith(OUT_DIR + path.sep)) return null;
  for (const file of [candidate, path.join(candidate, "index.html"), `${candidate}.html`]) {
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const server = createServer((req, res) => {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
  if (urlPath === "/" || urlPath === "/index.html") return send(res, 200, HOST_PAGE, TYPES[".html"]);
  if (urlPath === BASE) {
    res.writeHead(308, { Location: `${BASE}/` });
    return res.end();
  }
  if (!urlPath.startsWith(`${BASE}/`)) return send(res, 404, "Not under the demo's base path");
  const file = resolveFile(urlPath);
  if (!file) {
    const notFound = path.join(OUT_DIR, "404.html");
    return existsSync(notFound) ? send(res, 404, readFileSync(notFound), TYPES[".html"]) : send(res, 404, "Not found");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
});

if (!existsSync(OUT_DIR)) {
  console.error("out/ is missing: run `npm run build:web` first.");
  process.exit(1);
}
server.listen(PORT, () => {
  console.log(`Hunt web demo: http://localhost:${PORT}${BASE}/  (embedded: http://localhost:${PORT}/)`);
});
