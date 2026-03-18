const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3131;
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

let browserContext = null;

async function getBrowser() {
  if (browserContext) return browserContext;
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: true,
  });
  console.log('[server] Browser context ready');
  return browserContext;
}

// ── Search endpoint: GET /search?q=enter+sandman ──
async function handleSearch(query, res) {
  try {
    const encoded = encodeURIComponent(query);
    const apiUrl = `https://www.songsterr.com/api/search?pattern=${encoded}&size=20&from=0`;

    const ctx = await getBrowser();
    const page = await ctx.newPage();
    const resp = await page.goto(apiUrl, { timeout: 15000 });
    const data = await resp.json();
    await page.close();

    // Response format: { records: [...] }
    const records = data?.records || data || [];
    const results = records.map(s => ({
      songId: s.songId,
      title: s.title,
      artist: s.artist,
      tracks: (s.tracks || []).map(t => ({
        name: t.name,
        instrument: t.instrument,
        views: t.views,
      })),
    }));

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(results));
  } catch (e) {
    console.error('[search error]', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Download endpoint: GET /download/:songId ──
async function handleDownload(songId, res) {
  try {
    const ctx = await getBrowser();
    const page = await ctx.newPage();

    // Monitor for download
    let downloadFile = null;
    page.on('download', async dl => {
      const fileName = dl.suggestedFilename();
      const savePath = path.join(DOWNLOADS_DIR, fileName);
      await dl.saveAs(savePath);
      downloadFile = { name: fileName, path: savePath };
      console.log(`[download] Saved: ${fileName}`);
    });

    // Navigate to song page
    console.log(`[download] Loading song ${songId}...`);
    await page.goto(`https://www.songsterr.com/a/wsa/x-tab-s${songId}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Click Export
    const exportBtn = await page.locator('button[title*="indir"], button[title*="download"], button:has-text("Dışa Aktar"), button:has-text("Export")').first();
    if (!(await exportBtn.isVisible())) {
      await page.close();
      throw new Error('Export button not found - may need login');
    }
    await exportBtn.click();
    await page.waitForTimeout(1500);

    // Click Guitar Pro
    const gpBtn = await page.locator('span:has-text("Guitar Pro")').first();
    if (!(await gpBtn.isVisible())) {
      await page.close();
      throw new Error('Guitar Pro option not found - may need premium');
    }
    await gpBtn.click();

    // Wait for download to complete
    console.log(`[download] Waiting for file...`);
    for (let i = 0; i < 30; i++) {
      if (downloadFile) break;
      await page.waitForTimeout(1000);
    }

    await page.close();

    if (!downloadFile) {
      throw new Error('Download timeout');
    }

    // Send the file back
    const fileBuffer = fs.readFileSync(downloadFile.path);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadFile.name}"`,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': fileBuffer.length,
    });
    res.end(fileBuffer);
  } catch (e) {
    console.error('[download error]', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Login check: GET /auth/status ──
async function handleAuthStatus(res) {
  try {
    const ctx = await getBrowser();
    const page = await ctx.newPage();
    await page.goto('https://www.songsterr.com', { waitUntil: 'networkidle', timeout: 15000 });

    const status = await page.evaluate(() => {
      const body = document.body.innerText;
      const loggedIn = !body.includes('Giriş Yap') && !body.includes('Sign In') && !body.includes('Log In');
      // Try to find username
      const el = document.querySelector('[class*="profile"], [class*="user"], [class*="account"]');
      return { loggedIn, user: el?.textContent?.trim() || null };
    });

    await page.close();

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(status));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Login: GET /auth/login → opens visible browser ──
async function handleLogin(res) {
  try {
    // Close headless context
    if (browserContext) {
      await browserContext.close();
      browserContext = null;
    }

    // Open visible browser for login
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.songsterr.com/signin', { waitUntil: 'networkidle' });

    // Wait for login (max 120s)
    try {
      await page.waitForURL(u => !u.toString().includes('signin'), { timeout: 120000 });
      console.log('[auth] Login successful');
    } catch(e) {
      console.log('[auth] Login timeout');
    }

    await ctx.close();
    browserContext = null; // Will be recreated headless

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, message: 'Login flow completed' }));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── List downloaded files: GET /files ──
function handleFiles(res) {
  const files = fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => f.endsWith('.gp') || f.endsWith('.gp5') || f.endsWith('.gpx') || f.endsWith('.gp8'))
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(DOWNLOADS_DIR, f)).size,
      url: `/file/${encodeURIComponent(f)}`,
    }));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(files));
}

// ── Serve a downloaded file: GET /file/:name ──
function handleFile(name, res) {
  const filePath = path.join(DOWNLOADS_DIR, decodeURIComponent(name));
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
    return;
  }
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  if (pathname === '/search' && parsed.query.q) {
    await handleSearch(parsed.query.q, res);
  } else if (pathname.startsWith('/download/')) {
    const songId = pathname.split('/')[2];
    await handleDownload(songId, res);
  } else if (pathname === '/auth/status') {
    await handleAuthStatus(res);
  } else if (pathname === '/auth/login') {
    await handleLogin(res);
  } else if (pathname === '/files') {
    handleFiles(res);
  } else if (pathname.startsWith('/file/')) {
    const name = pathname.substring(6);
    handleFile(name, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: [
      'GET /search?q=<query>',
      'GET /download/<songId>',
      'GET /auth/status',
      'GET /auth/login',
      'GET /files',
      'GET /file/<name>',
    ]}));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Songsterr Proxy Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET /search?q=enter+sandman   → Search songs`);
  console.log(`    GET /download/84              → Download GP file`);
  console.log(`    GET /auth/status              → Check login`);
  console.log(`    GET /auth/login               → Open browser to login`);
  console.log(`    GET /files                    → List downloaded files`);
  console.log(`    GET /file/<name>              → Serve a downloaded file\n`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browserContext) await browserContext.close();
  process.exit();
});
