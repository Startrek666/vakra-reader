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
 *   Browser test UI
 */

import http from "node:http";

const PORT = parseInt(process.env.PORT || "3100", 10);
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

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

  // ── 测试 UI 页面 ──────────────────────────────────────────────────────
  if (url.pathname === "/" && req.method === "GET") {
    const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vakra Reader - 测试工具</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; }
  header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; color: #58a6ff; }
  header span { font-size: 12px; color: #8b949e; background: #21262d; border: 1px solid #30363d; border-radius: 12px; padding: 2px 8px; }
  .container { display: grid; grid-template-columns: 1fr 1fr; gap: 0; height: calc(100vh - 57px); }
  .panel { display: flex; flex-direction: column; border-right: 1px solid #30363d; }
  .panel-header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 16px; font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: space-between; }
  .panel-body { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  textarea#url-input { background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #e1e4e8; padding: 10px 12px; font-size: 13px; resize: vertical; min-height: 120px; font-family: monospace; line-height: 1.5; width: 100%; }
  textarea#url-input:focus { outline: none; border-color: #58a6ff; box-shadow: 0 0 0 3px rgba(88,166,255,.15); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label { font-size: 12px; color: #8b949e; white-space: nowrap; }
  select, input[type=number] { background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #e1e4e8; padding: 6px 8px; font-size: 13px; }
  button#scrape-btn { background: #238636; border: 1px solid #2ea043; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; padding: 10px 20px; width: 100%; transition: background .15s; }
  button#scrape-btn:hover { background: #2ea043; }
  button#scrape-btn:disabled { background: #21262d; border-color: #30363d; color: #484f58; cursor: not-allowed; }
  .tabs { display: flex; overflow-x: auto; border-bottom: 1px solid #30363d; background: #161b22; }
  .tab { padding: 8px 16px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; color: #8b949e; white-space: nowrap; flex-shrink: 0; }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab-content { display: none; padding: 16px; overflow: auto; height: 100%; }
  .tab-content.active { display: block; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: 'Courier New', monospace; font-size: 12px; line-height: 1.6; }
  .markdown-view { font-size: 14px; line-height: 1.75; }
  .markdown-view h1, .markdown-view h2, .markdown-view h3 { color: #58a6ff; margin: 16px 0 8px; }
  .markdown-view h1 { font-size: 20px; } .markdown-view h2 { font-size: 17px; } .markdown-view h3 { font-size: 15px; }
  .markdown-view p { margin-bottom: 10px; }
  .markdown-view code { background: #21262d; border-radius: 3px; padding: 1px 5px; font-family: monospace; font-size: 12px; }
  .markdown-view pre { background: #21262d; border-radius: 6px; padding: 12px; margin-bottom: 12px; overflow-x: auto; }
  .markdown-view ul, .markdown-view ol { padding-left: 20px; margin-bottom: 10px; }
  .markdown-view table { border-collapse: collapse; width: 100%; margin-bottom: 12px; font-size: 13px; }
  .markdown-view th, .markdown-view td { border: 1px solid #30363d; padding: 6px 10px; }
  .markdown-view th { background: #21262d; }
  .markdown-view a { color: #58a6ff; }
  .status.ok { color: #3fb950; } .status.err { color: #f85149; }
  .meta-bar { background: #161b22; border-bottom: 1px solid #30363d; padding: 8px 16px; font-size: 12px; color: #8b949e; min-height: 36px; display: flex; align-items: center; gap: 16px; font-family: monospace; flex-wrap: wrap; }
  .info-bar { background: #21262d; border-radius: 6px; padding: 8px 12px; font-size: 12px; font-family: monospace; color: #8b949e; margin-bottom: 12px; }
  .view-btns { display: flex; gap: 8px; margin-bottom: 12px; }
  .view-btn { background: #21262d; border: 1px solid #30363d; color: #e1e4e8; border-radius: 5px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .view-btn.active { background: #238636; border-color: #2ea043; color: #fff; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .result-panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  #tab-contents { flex: 1; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1>Vakra Reader</h1>
  <span>Web Content Extraction API</span>
  <span id="health-badge" style="margin-left:auto">checking...</span>
</header>
<div class="container">
  <div class="panel">
    <div class="panel-header">输入 URLs</div>
    <div class="panel-body">
      <textarea id="url-input" placeholder="每行一个 URL，支持批量&#10;https://example.com&#10;https://another-site.com"></textarea>
      <div class="row">
        <label>格式</label>
        <select id="fmt"><option value="markdown">Markdown</option><option value="html">HTML</option></select>
        <label>并发</label>
        <input type="number" id="conc" value="3" min="1" max="10" style="width:56px">
        <label>超时(s)</label>
        <input type="number" id="tout" value="30" min="5" max="120" style="width:64px">
      </div>
      <button id="scrape-btn" onclick="doScrape()">抓取内容 (Ctrl+Enter)</button>
    </div>
  </div>

  <div class="panel result-panel" style="border-right:none">
    <div class="panel-header">
      抓取结果
      <span id="status-text" class="status"></span>
    </div>
    <div class="meta-bar" id="meta-bar">等待抓取...</div>
    <div class="tabs" id="tabs-container"></div>
    <div id="tab-contents"></div>
  </div>
</div>

<script>
fetch('/health').then(r=>r.json()).then(d=>{
  const b=document.getElementById('health-badge');
  b.textContent=d.status==='ok'?'Service OK':'Unhealthy';
  b.style.color=d.status==='ok'?'#3fb950':'#f85149';
}).catch(()=>{ document.getElementById('health-badge').textContent='Unreachable'; document.getElementById('health-badge').style.color='#f85149'; });

async function doScrape(){
  const raw=document.getElementById('url-input').value.trim();
  if(!raw){alert('请输入至少一个 URL');return;}
  const urls=raw.split('\\n').map(u=>u.trim()).filter(u=>u.startsWith('http'));
  if(!urls.length){alert('未检测到有效 URL（需以 http:// 或 https:// 开头）');return;}

  const fmt=document.getElementById('fmt').value;
  const conc=parseInt(document.getElementById('conc').value)||3;
  const tout=parseInt(document.getElementById('tout').value)||30;
  const btn=document.getElementById('scrape-btn');
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span>抓取中...';
  document.getElementById('status-text').textContent='';
  document.getElementById('meta-bar').innerHTML='<span class="spinner"></span>正在抓取 '+urls.length+' 个页面...';
  document.getElementById('tabs-container').innerHTML='';
  document.getElementById('tab-contents').innerHTML='';

  const t0=Date.now();
  try{
    const r=await fetch('/scrape',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({urls,formats:[fmt],concurrency:conc,timeout:tout*1000})});
    const data=await r.json();
    const elapsed=((Date.now()-t0)/1000).toFixed(1);
    if(!data.success)throw new Error(data.error||'Unknown error');

    const m=data.metadata||{};
    document.getElementById('meta-bar').innerHTML=
      '成功 <b style="color:#3fb950">'+m.successful+'</b>/'+m.total+
      ' 　失败 <b style="color:#f85149">'+m.failed+'</b>'+
      ' 　客户端耗时 <b>'+elapsed+'s</b>'+
      ' 　服务端耗时 <b>'+(m.duration||0)+'ms</b>';

    const st=document.getElementById('status-text');
    st.textContent=m.failed>0?m.failed+' 个失败':'全部成功';
    st.className='status '+(m.failed>0?'err':'ok');

    const tabsEl=document.getElementById('tabs-container');
    const contEl=document.getElementById('tab-contents');
    const items=data.data||[];

    if(!items.length){
      contEl.innerHTML='<div style="padding:32px;color:#8b949e;text-align:center">未获取到任何内容</div>';
    }

    items.forEach((item,i)=>{
      const label=(item.title||item.url||'Page '+(i+1)).slice(0,25);
      const tab=document.createElement('div');
      tab.className='tab'+(i===0?' active':'');
      tab.textContent=label; tab.title=item.url;
      tab.onclick=()=>selectTab(i);
      tabsEl.appendChild(tab);

      const c=document.createElement('div');
      c.className='tab-content'+(i===0?' active':'');
      c.id='tab-'+i;

      const rawContent=item[fmt]||'';
      c.innerHTML='<div class="info-bar">'+
        '<b style="color:#58a6ff">URL:</b> '+esc(item.url)+'<br>'+
        '<b style="color:#58a6ff">Title:</b> '+esc(item.title||'—')+'<br>'+
        '<b style="color:#58a6ff">Length:</b> '+rawContent.length+' chars'+'</div>'+
        (fmt==='markdown'?
          '<div class="view-btns">'+
          '<button class="view-btn active" id="vb-md-'+i+'" onclick="tv('+i+',\'md\')">渲染预览</button>'+
          '<button class="view-btn" id="vb-raw-'+i+'" onclick="tv('+i+',\'raw\')">原始 Markdown</button>'+
          '</div>'+
          '<div id="vm-'+i+'" class="markdown-view">'+md2html(rawContent)+'</div>'+
          '<pre id="vr-'+i+'" style="display:none">'+esc(rawContent)+'</pre>'
          :'<pre>'+esc(rawContent)+'</pre>'
        );
      contEl.appendChild(c);
    });

    if(m.errors&&m.errors.length){
      const et=document.createElement('div');
      et.className='tab'; et.textContent='失败('+m.errors.length+')'; et.style.color='#f85149';
      et.onclick=()=>selectTab(items.length); tabsEl.appendChild(et);
      const ec=document.createElement('div');
      ec.className='tab-content'; ec.id='tab-'+items.length;
      ec.innerHTML='<pre style="color:#f85149">'+esc(JSON.stringify(m.errors,null,2))+'</pre>';
      contEl.appendChild(ec);
    }
  }catch(e){
    document.getElementById('meta-bar').textContent='错误: '+e.message;
    document.getElementById('meta-bar').style.color='#f85149';
    document.getElementById('status-text').textContent='失败';
    document.getElementById('status-text').className='status err';
  }
  btn.disabled=false; btn.textContent='抓取内容 (Ctrl+Enter)';
}

function selectTab(i){
  document.querySelectorAll('.tab').forEach((t,j)=>t.className='tab'+(j===i?' active':''));
  document.querySelectorAll('.tab-content').forEach((c,j)=>c.className='tab-content'+(j===i?' active':''));
}
function tv(i,mode){
  const md=document.getElementById('vm-'+i),raw=document.getElementById('vr-'+i);
  const bmd=document.getElementById('vb-md-'+i),braw=document.getElementById('vb-raw-'+i);
  if(mode==='md'){md.style.display='';raw.style.display='none';bmd.className='view-btn active';braw.className='view-btn';}
  else{md.style.display='none';raw.style.display='';bmd.className='view-btn';braw.className='view-btn active';}
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function md2html(md){
  if(!md)return'';
  let h=esc(md);
  h=h.replace(/\`\`\`[^\n]*\n([\s\S]*?)\`\`\`/g,'<pre><code>$1</code></pre>');
  h=h.replace(/^#{6}\s+(.+)$/gm,'<h6>$1</h6>');
  h=h.replace(/^#{5}\s+(.+)$/gm,'<h5>$1</h5>');
  h=h.replace(/^#{4}\s+(.+)$/gm,'<h4>$1</h4>');
  h=h.replace(/^#{3}\s+(.+)$/gm,'<h3>$1</h3>');
  h=h.replace(/^#{2}\s+(.+)$/gm,'<h2>$1</h2>');
  h=h.replace(/^#{1}\s+(.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  h=h.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  h=h.replace(/^[-*]\s+(.+)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>.*<\/li>\n?)+/g,'<ul>$&</ul>');
  h=h.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>');
  return '<p>'+h+'</p>';
}
document.getElementById('url-input').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')doScrape();});
</script>
</body>
</html>`;
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
    res.end(html);
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
