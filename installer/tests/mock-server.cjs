/**
 * Mock raw.githubusercontent server for installer bootstrap tests.
 * Usage: node mock-server.cjs <repoRoot> <portFile>
 *
 * Routes:
 *   /ok/<path>        → serves the real repository file at <path>
 *   /missing/<path>   → 404 for installer/lib/mongo-compat.sh, real files otherwise
 *   /empty/<path>     → 200 with an empty body for mongo-compat.sh
 *   /corrupt/<path>   → 200 with invalid bash for mongo-compat.sh
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const [repoRoot, portFile] = process.argv.slice(2);

function serve(res, filePath, overrideBody) {
  if (overrideBody !== undefined) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(overrideBody);
    return;
  }
  const full = path.join(repoRoot, filePath);
  if (!fs.existsSync(full)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(fs.readFileSync(full));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // e.g. [ok, installer, lib, mongo-compat.sh]
  const mode = parts[0];
  const rel = parts.slice(1).join("/");
  if (mode === "missing" && rel === "installer/lib/mongo-compat.sh") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (mode === "empty" && rel === "installer/lib/mongo-compat.sh") {
    serve(res, rel, "");
    return;
  }
  if (mode === "corrupt" && rel === "installer/lib/mongo-compat.sh") {
    serve(res, rel, "this is not valid bash (((");
    return;
  }
  serve(res, rel);
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
