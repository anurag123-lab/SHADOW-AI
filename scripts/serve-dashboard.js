/**
 * Zero-dependency static server for the dashboard.
 *
 * The dashboard needs to be served over http, not opened as file://:
 * Supabase's OAuth redirect and session storage both require a real
 * origin. This is the smallest thing that provides one.
 *
 * Run: npm run serve:dashboard   ->   http://localhost:5500
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "dashboard");
const PORT = Number(process.env.PORT || 5500);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);

    // Keep the server inside the dashboard directory.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || stat.isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(res);
    });
  })
  .listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
    console.log(`Serving ${ROOT}`);
    console.log("\nAdd this to Supabase -> Authentication -> URL Configuration -> Redirect URLs:");
    console.log(`  http://localhost:${PORT}/**`);
  })
  .on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${PORT} is already in use — the dashboard is probably already running.`);
      console.log(`Open http://localhost:${PORT}, or stop the other server first.`);
      console.log(`(To use another port: set PORT=5501 and run again.)`);
      process.exit(0);
    }
    throw err;
  });
