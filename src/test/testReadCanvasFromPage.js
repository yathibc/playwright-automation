const http = require('http');
const fs = require('fs');
const path = require('path');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const { chromium } = require('playwright');
const KonvaSeatMapResolver = require('../utils/konvaSeatMapResolver');

const root = path.join(__dirname, '../..');
const harnessPath = '/src/test/konvaCanvasReadHarness.html';

function createStaticServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(root, urlPath);

    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

async function clickSeatsAndAddToCart(page, seats) {
  for (const seat of seats) {
    await page.mouse.click(seat.browserX, seat.browserY, { delay: 75 });
  }

  const selectedKeys = seats.map(seat => `${seat.stand || seat.sandbox || '1'}-${seat.row}-${seat.number}`);
  const response = await page.evaluate(keys => window.__simulateAddToCart?.(keys), selectedKeys);
  return { response, selectedKeys };
}

async function readCanvasState(page, pool) {
  const resolver = new KonvaSeatMapResolver({ pool });
  const result = await resolver.readSeatsFromCanvas(page, 1.0);
  return { result, resolver };
}

async function runScenario(page, scenario, pool = 'D', seatlist = 'default') {
  const url = `http://127.0.0.1:8787${harnessPath}?scenario=${encodeURIComponent(scenario)}&pool=${encodeURIComponent(pool)}&seatlist=${encodeURIComponent(seatlist)}`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__HARNESS__, null, { timeout: 10000 });

  const harness = await page.evaluate(() => window.__HARNESS__);
  const attemptLog = [];
  let finalResponse = null;
  let attempt = 0;

  while (attempt < 6) {
    attempt += 1;

    const { result, resolver } = await readCanvasState(page, pool);
    const consecutive = resolver.findConsecutiveCanvasSeats(result.canvasSeats || [], 2);
    const availableUnselected = (result.canvasSeats || []).filter(s => !s.selected);

    if (!consecutive || consecutive.length < 2) {
      attemptLog.push({ attempt, status: 'no-consecutive', seats: [] });
      break;
    }

    const { response, selectedKeys } = await clickSeatsAndAddToCart(page, consecutive);
    attemptLog.push({ attempt, seats: selectedKeys, response });

    finalResponse = response;
    if (response?.status === 'Success') {
      break;
    }

    await page.waitForTimeout(400);
  }

  const finalCanvas = await readCanvasState(page, pool);
  const consecutive2 = finalCanvas.resolver.findConsecutiveCanvasSeats(finalCanvas.result.canvasSeats || [], 2);
  const consecutive3 = finalCanvas.resolver.findConsecutiveCanvasSeats(finalCanvas.result.canvasSeats || [], 3);
  const availableUnselected = (finalCanvas.result.canvasSeats || []).filter(s => !s.selected);

  return {
    scenario,
    seatlist,
    harness,
    attempts: attemptLog,
    canvasRead: {
      totalAvailable: (finalCanvas.result.canvasSeats || []).length,
      unselectedAvailable: availableUnselected.length,
      selectedAvailable: (finalCanvas.result.canvasSeats || []).filter(s => s.selected).length,
      stageInfo: finalCanvas.result.stageInfo,
      consecutive2: consecutive2 ? consecutive2.map(s => `${s.konvaX},${s.konvaY}`) : null,
      consecutive3: consecutive3 ? consecutive3.map(s => `${s.konvaX},${s.konvaY}`) : null
    }
  };
}

async function main() {
  const server = createStaticServer();
  await new Promise(resolve => server.listen(8787, '127.0.0.1', resolve));

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const scenarios = [
    { scenario: 'baseline', seatlist: 'default' },
    { scenario: 'baseline', seatlist: 'seatlist-success' },
    { scenario: 'baseline', seatlist: 'seatlist-no-consecutive' },
    { scenario: 'scaled', seatlist: 'seatlist-success' },
    { scenario: 'panned', seatlist: 'seatlist-success' },
    { scenario: 'baseline', seatlist: 'seatlist-retry-step1' },
    { scenario: 'baseline', seatlist: 'seatlist-retry-step2' },
    { scenario: 'baseline', seatlist: 'seatlist-stand-full' }
  ];
  const reports = [];

  try {
    for (const entry of scenarios) {
      const report = await runScenario(page, entry.scenario, 'D', entry.seatlist);
      reports.push(report);
      console.log(`\n=== ${entry.scenario.toUpperCase()} / ${entry.seatlist} ===`);
      console.log(JSON.stringify(report, null, 2));
    }

    const baseline = reports.find(r => r.scenario === 'baseline' && r.harness.seatlistVariant === 'default');
    const success = reports.find(r => r.harness.seatlistVariant === 'seatlist-success');
    const noConsecutive = reports.find(r => r.harness.seatlistVariant === 'seatlist-no-consecutive');
    const retryStep1 = reports.find(r => r.harness.seatlistVariant === 'seatlist-retry-step1');
    const retryStep2 = reports.find(r => r.harness.seatlistVariant === 'seatlist-retry-step2');
    const standFull = reports.find(r => r.harness.seatlistVariant === 'seatlist-stand-full');

    if (!baseline || baseline.canvasRead.totalAvailable <= 0) {
      throw new Error('Baseline scenario did not detect any available seats from canvas');
    }
    if (!success || !success.canvasRead.consecutive2) {
      throw new Error('Success seatlist did not provide a clickable consecutive pair');
    }
    if (!noConsecutive || noConsecutive.canvasRead.consecutive2) {
      throw new Error('No-consecutive seatlist unexpectedly found a consecutive pair');
    }
    if (!retryStep1 || !retryStep1.canvasRead.consecutive2) {
      throw new Error('Retry step 1 did not provide an initial consecutive pair');
    }
    if (!retryStep2 || !retryStep2.canvasRead.consecutive2) {
      throw new Error('Retry step 2 did not provide a fallback consecutive pair');
    }
    if (!standFull || standFull.canvasRead.totalAvailable !== 0) {
      throw new Error('Stand-full seatlist should produce zero available seats');
    }

    console.log('\nCanvas-read harness validation passed.');
  } finally {
    await browser.close();
    server.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = main;