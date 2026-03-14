/**
 * Vakra Reader HTTP API Server
 *
 * 为 Python 后端提供 HTTP 接口，将网页 URL 转换为干净的 Markdown。
 *
 * POST /scrape
 *   Body: { "urls": ["https://..."], "formats": ["markdown"], "concurrency": 5, "timeout": 30000 }
 *   Response: { "success": true, "data": [{ "url": "...", "markdown": "...", "title": "..." }] }
 *
 * GET /health
 *   Response: { "status": "ok" }
 *
 * GET /
 *   Browser test UI (served from public/index.html)
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3100", 10);
const MAX_BODY_SIZE = 1024 * 1024; // 1MB
// 是否遵守 robots.txt（默认 false，知乎等网站会封禁）
const RESPECT_ROBOTS = process.env.RESPECT_ROBOTS_TXT === "true";

// 单例 ReaderClient，跨请求复用（避免重复初始化 HeroCore / 浏览器池）
let readerInstance = null;
let readerInitializing = false;

async function getReader() {
  if (readerInstance) return readerInstance;

  // 防止并发初始化
  if (readerInitializing) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return getReader();
  }

  readerInitializing = true;
  try {
    const { ReaderClient } = await import("@vakra-dev/reader");
    readerInstance = new ReaderClient({
      verbose: process.env.VERBOSE === "true",
      browserPool: {
        size: parseInt(process.env.POOL_SIZE || "3", 10),
        retireAfterPages: 100,
        retireAfterMinutes: 30,
      },
    });
    console.log("[vakra-reader] Reader client initialized");
    return readerInstance;
  } finally {
    readerInitializing = false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── 测试 UI 页面（从独立 HTML 文件加载）──────────────────────────────
  if (url.pathname === "/" && req.method === "GET") {
    try {
      const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
      res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
      res.end(html);
    } catch (e) {
      sendJson(res, 500, { error: "Test UI not found: " + e.message });
    }
    return;
  }

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }

  // Scrape endpoint
  if (url.pathname === "/scrape" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const urls = body.urls || [];
      const formats = body.formats || ["markdown"];
      const concurrency = body.concurrency || 5;
      const timeoutMs = body.timeout || 30000;
      const batchTimeoutMs = body.batch_timeout || timeoutMs * urls.length + 10000;
      const skipEngines = body.skip_engines || [];

      if (!urls.length) {
        return sendJson(res, 400, { success: false, error: "No URLs provided" });
      }

      console.log(`[vakra-reader] Scraping ${urls.length} URLs (concurrency=${concurrency}, timeout=${timeoutMs}ms)...`);
      const reader = await getReader();

      const result = await reader.scrape({
        urls,
        formats,
        batchConcurrency: concurrency,
        timeoutMs,
        batchTimeoutMs,
        maxRetries: 1,
        skipEngines,
        respectRobotsTxt: body.respect_robots_txt ?? RESPECT_ROBOTS,
      });

      const data = result.data.map((item) => ({
        url: item.metadata?.baseUrl || "",
        title: item.metadata?.website?.title || item.metadata?.website?.openGraph?.title || "",
        markdown: item.markdown || "",
        html: item.html || "",
        duration: item.metadata?.duration || 0,
      }));

      console.log(
        `[vakra-reader] Done: ${result.batchMetadata.successfulUrls}/${result.batchMetadata.totalUrls} succeeded in ${result.batchMetadata.totalDuration}ms`
      );

      return sendJson(res, 200, {
        success: true,
        data,
        metadata: {
          total: result.batchMetadata.totalUrls,
          successful: result.batchMetadata.successfulUrls,
          failed: result.batchMetadata.failedUrls,
          duration: result.batchMetadata.totalDuration,
          errors: result.batchMetadata.errors || [],
        },
      });
    } catch (err) {
      console.error("[vakra-reader] Scrape error:", err.message);
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[vakra-reader] HTTP server listening on port ${PORT}`);
});

// Graceful shutdown
// ReaderClient 构造时已注册 SIGTERM，这里只关闭 HTTP server
process.on("SIGTERM", () => {
  console.log("[vakra-reader] SIGTERM received, shutting down...");
  server.close(() => {
    console.log("[vakra-reader] HTTP server closed");
    process.exit(0);
  });
});
process.on("SIGINT", () => process.emit("SIGTERM"));
