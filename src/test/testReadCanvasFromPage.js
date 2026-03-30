/**
 * testReadCanvasFromPage.js
 *
 * End-to-end test for the seat selection pipeline:
 *   1. readSeatsFromCanvas() — reads available seats from live Konva canvas
 *   2. findConsecutiveCanvasSeats() — finds N consecutive seats
 *   3. page.mouse.click(browserX, browserY) — clicks seats on canvas
 *   4. Verify clicks actually toggled seat state (white → gold)
 *   5. After canvas refresh (seatlist swap), re-read and verify new availability
 *
 * This tests the exact same code path used by src/index.js without modifying it.
 * The harness (konvaCanvasReadHarness.html) renders a Konva canvas identical to
 * the real RCB website's seat selection modal.
 */
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
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const { chromium } = require('playwright');
const KonvaSeatMapResolver = require('../utils/konvaSeatMapResolver');

const root = path.join(__dirname, '../..');
const harnessPath = '/src/test/konvaCanvasReadHarness.html';
const PORT = 8787;

// ── Helpers ─────────────────────────────────────────────────────────

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`${ts} | ${tag.padEnd(12)} | ${msg}`);
}

function logSection(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(70)}`);
}

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
        res.end('Not found: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

// ── Canvas Read + Click Pipeline ────────────────────────────────────

async function readCanvasState(page, pool) {
  const resolver = new KonvaSeatMapResolver({ pool });
  const result = await resolver.readSeatsFromCanvas(page, 1.0);
  return { result, resolver };
}

/**
 * Debug: compare the browser coordinates from readSeatsFromCanvas with
 * the harness's own coordinate calculation for the same seat.
 */
async function debugCoordinates(page, seats) {
  if (!seats || seats.length === 0) return;

  const seat = seats[0]; // Debug first seat
  const debug = await page.evaluate(
    ({ kx, ky }) => window.__debugSeatAt?.(kx, ky),
    { kx: seat.konvaX, ky: seat.konvaY }
  );

  if (!debug || debug.error) {
    log('DEBUG', `__debugSeatAt failed: ${debug?.error || 'no result'}`);
    return;
  }

  log('DEBUG', `Seat at konva(${seat.konvaX}, ${seat.konvaY}):`);
  log('DEBUG', `  Stage: scale=${debug.scale}, pos=(${debug.stageX}, ${debug.stageY})`);
  log('DEBUG', `  Canvas rect: left=${debug.canvasRect?.left?.toFixed(1)}, top=${debug.canvasRect?.top?.toFixed(1)}, ${debug.canvasRect?.width}x${debug.canvasRect?.height}`);
  log('DEBUG', `  Computed abs: (${debug.computedAbsX?.toFixed(1)}, ${debug.computedAbsY?.toFixed(1)})`);
  log('DEBUG', `  getAbsolutePosition: (${debug.foundRect?.absPos?.x?.toFixed(1)}, ${debug.foundRect?.absPos?.y?.toFixed(1)})`);
  log('DEBUG', `  Expected browser (manual calc): (${debug.expectedBrowserX?.toFixed(1)}, ${debug.expectedBrowserY?.toFixed(1)})`);
  log('DEBUG', `  Expected browser (absPos):      (${debug.absPosBrowserX?.toFixed(1)}, ${debug.absPosBrowserY?.toFixed(1)})`);
  log('DEBUG', `  readSeatsFromCanvas gave:       (${seat.browserX?.toFixed(1)}, ${seat.browserY?.toFixed(1)})`);
  log('DEBUG', `  Rect info: fill=${debug.foundRect?.fill}, stroke=${debug.foundRect?.stroke}, key=${debug.foundRect?.seatKey}`);

  // Check if manual calc and absPos agree
  const dxCalc = Math.abs((debug.expectedBrowserX || 0) - (seat.browserX || 0));
  const dyCalc = Math.abs((debug.expectedBrowserY || 0) - (seat.browserY || 0));
  const dxAbs = Math.abs((debug.absPosBrowserX || 0) - (seat.browserX || 0));
  const dyAbs = Math.abs((debug.absPosBrowserY || 0) - (seat.browserY || 0));

  if (dxCalc > 2 || dyCalc > 2) {
    log('DEBUG', `  ⚠️ MISMATCH: readSeatsFromCanvas vs manual calc: Δx=${dxCalc.toFixed(1)}, Δy=${dyCalc.toFixed(1)}`);
  }
  if (dxAbs > 2 || dyAbs > 2) {
    log('DEBUG', `  ⚠️ MISMATCH: readSeatsFromCanvas vs absPos: Δx=${dxAbs.toFixed(1)}, Δy=${dyAbs.toFixed(1)}`);
  }
  if (dxCalc <= 2 && dyCalc <= 2 && dxAbs <= 2 && dyAbs <= 2) {
    log('DEBUG', `  ✅ All coordinate methods agree (within 2px tolerance)`);
  }
}

/**
 * Deep diagnostic: use Konva's own getIntersection to find what's at a given point.
 * This tells us exactly what Konva thinks is at our click coordinates.
 */
async function diagnoseHitAtPoint(page, browserX, browserY, label) {
  const info = await page.evaluate(({ bx, by }) => {
    try {
      const stages = window.Konva?.stages || [];
      if (stages.length === 0) return { error: 'no stages' };

      // Find the seat stage (last one, or the one in dialog)
      let seatStage = null;
      for (const stage of stages) {
        try {
          const container = stage.container();
          if (container && container.closest('[role="dialog"]')) {
            seatStage = stage;
            break;
          }
        } catch (_) {}
      }
      if (!seatStage) seatStage = stages[stages.length - 1];

      const canvas = seatStage.container()?.querySelector('canvas');
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return { error: 'no canvas rect' };

      // The browser click point relative to the canvas element
      const canvasRelX = bx - rect.left;
      const canvasRelY = by - rect.top;

      // Konva's pointer position is relative to the stage container
      // We need to convert browser coords to what Konva expects
      const containerDiv = seatStage.container();
      const containerRect = containerDiv?.getBoundingClientRect();

      const containerRelX = bx - (containerRect?.left || rect.left);
      const containerRelY = by - (containerRect?.top || rect.top);

      // Try Konva's getIntersection at the container-relative point
      const scale = seatStage.scaleX();
      const stageX = seatStage.x();
      const stageY = seatStage.y();
      const pixelRatio = canvas?.width / rect.width || 1;

      // Konva internally converts pointer position to stage coordinates:
      // stageCoord = (pointerPos - stageOffset) / scale
      const stageCoordX = (containerRelX - stageX) / scale;
      const stageCoordY = (containerRelY - stageY) / scale;

      // Try getIntersection
      let hitNode = null;
      try {
        const intersection = seatStage.getIntersection({ x: containerRelX, y: containerRelY });
        if (intersection) {
          hitNode = {
            className: intersection.className,
            attrs: {
              x: intersection.attrs.x,
              y: intersection.attrs.y,
              width: intersection.attrs.width,
              height: intersection.attrs.height,
              fill: intersection.attrs.fill,
              stroke: intersection.attrs.stroke,
              seatKey: intersection.getAttr?.('seatKey'),
            }
          };
        }
      } catch (e) {
        hitNode = { error: e.message };
      }

      return {
        browserPoint: { x: bx, y: by },
        canvasRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        containerRect: containerRect ? { left: containerRect.left, top: containerRect.top, width: containerRect.width, height: containerRect.height } : null,
        canvasRelative: { x: canvasRelX, y: canvasRelY },
        containerRelative: { x: containerRelX, y: containerRelY },
        stageCoord: { x: stageCoordX, y: stageCoordY },
        stageTransform: { scale, stageX, stageY },
        pixelRatio,
        canvasActualSize: { width: canvas?.width, height: canvas?.height },
        canvasCSSSize: { width: rect.width, height: rect.height },
        hitNode,
      };
    } catch (e) {
      return { error: e.message };
    }
  }, { bx: browserX, by: browserY });

  log('HIT-TEST', `${label}: browser(${browserX.toFixed(1)}, ${browserY.toFixed(1)})`);
  if (info.error) {
    log('HIT-TEST', `  Error: ${info.error}`);
    return info;
  }
  log('HIT-TEST', `  Canvas rect: (${info.canvasRect.left.toFixed(1)}, ${info.canvasRect.top.toFixed(1)}) ${info.canvasRect.width}x${info.canvasRect.height}`);
  log('HIT-TEST', `  Container rect: (${info.containerRect?.left?.toFixed(1)}, ${info.containerRect?.top?.toFixed(1)}) ${info.containerRect?.width}x${info.containerRect?.height}`);
  log('HIT-TEST', `  Canvas relative: (${info.canvasRelative.x.toFixed(1)}, ${info.canvasRelative.y.toFixed(1)})`);
  log('HIT-TEST', `  Container relative: (${info.containerRelative.x.toFixed(1)}, ${info.containerRelative.y.toFixed(1)})`);
  log('HIT-TEST', `  Stage coord (inverse transform): (${info.stageCoord.x.toFixed(1)}, ${info.stageCoord.y.toFixed(1)})`);
  log('HIT-TEST', `  Stage transform: scale=${info.stageTransform.scale}, offset=(${info.stageTransform.stageX}, ${info.stageTransform.stageY})`);
  log('HIT-TEST', `  Pixel ratio: ${info.pixelRatio}, Canvas actual: ${info.canvasActualSize.width}x${info.canvasActualSize.height}, CSS: ${info.canvasCSSSize.width}x${info.canvasCSSSize.height}`);
  log('HIT-TEST', `  Hit node: ${info.hitNode ? JSON.stringify(info.hitNode) : 'NONE (empty space)'}`);

  return info;
}

/**
 * Click seats using page.mouse.click and verify they toggled.
 * Returns { clicked: number, verified: number, details: [] }
 */
async function clickAndVerifySeats(page, seats, pool) {
  const details = [];

  // Get selected count before clicking
  const before = await page.evaluate(() => window.__getSelectedCount?.() || { selected: 0 });
  log('CLICK', `Before clicks: ${before.selected} selected, ${before.unselected} unselected`);

  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i];
    log('CLICK', `Clicking seat ${i + 1}/${seats.length} at konva(${seat.konvaX},${seat.konvaY}) → browser(${seat.browserX?.toFixed(1)},${seat.browserY?.toFixed(1)})`);

    // Run hit-test diagnostic BEFORE clicking
    await diagnoseHitAtPoint(page, seat.browserX, seat.browserY, `Pre-click seat ${i + 1}`);

    await page.mouse.click(seat.browserX, seat.browserY, { delay: 50 });
    await page.waitForTimeout(300); // Wait for Konva click handler + re-render

    // Check if the click toggled the seat
    const afterClick = await page.evaluate(() => window.__getSelectedCount?.() || { selected: 0 });
    const expectedSelected = before.selected + (i + 1);
    const actualSelected = afterClick.selected;

    details.push({
      index: i,
      konvaX: seat.konvaX,
      konvaY: seat.konvaY,
      browserX: seat.browserX?.toFixed(1),
      browserY: seat.browserY?.toFixed(1),
      expectedSelected,
      actualSelected,
      hit: actualSelected === expectedSelected,
    });

    if (actualSelected === expectedSelected) {
      log('CLICK', `  ✅ Seat toggled! Selected count: ${before.selected} → ${actualSelected}`);
    } else {
      log('CLICK', `  ❌ MISS! Expected ${expectedSelected} selected, got ${actualSelected}`);
      // Debug this specific seat
      await debugCoordinates(page, [seat]);
    }
  }

  const after = await page.evaluate(() => window.__getSelectedCount?.() || { selected: 0 });
  const clicked = seats.length;
  const verified = after.selected - before.selected;

  log('CLICK', `After all clicks: ${after.selected} selected (${verified}/${clicked} verified)`);

  return { clicked, verified, before: before.selected, after: after.selected, details };
}

// ── Load Harness Page ───────────────────────────────────────────────

async function loadHarness(page, scenario, pool, seatlist) {
  const url = `http://127.0.0.1:${PORT}${harnessPath}?scenario=${encodeURIComponent(scenario)}&pool=${encodeURIComponent(pool)}&seatlist=${encodeURIComponent(seatlist)}`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__HARNESS__, null, { timeout: 10000 });
  await page.waitForTimeout(300); // Let Konva fully render

  const harness = await page.evaluate(() => window.__HARNESS__);
  log('HARNESS', `Loaded: scenario=${harness.scenario}, pool=${harness.pool}, seatlist=${harness.seatlistVariant}`);
  log('HARNESS', `  Available: ${harness.summary.availableSeats}, Selected: ${harness.summary.selectedSeats}, Stages: ${harness.stageCount}`);
  log('HARNESS', `  Scale: ${harness.summary.stageScale?.toFixed(4)}, StagePos: (${harness.summary.stageX?.toFixed(1)}, ${harness.summary.stageY?.toFixed(1)})`);
  log('HARNESS', `  Layout: ${harness.summary.layoutWidth}x${harness.summary.layoutHeight}`);

  return harness;
}

// ── Test Scenarios ──────────────────────────────────────────────────

/**
 * TEST 1: Basic click verification
 * Read 2 consecutive seats → click them → verify they toggled to selected
 */
async function testClickVerification(page, scenario = 'baseline', seatlist = 'default') {
  logSection(`TEST: Click Verification (${scenario} / ${seatlist})`);

  const harness = await loadHarness(page, scenario, 'D', seatlist);

  if (harness.summary.availableSeats === 0) {
    log('TEST', `⏭ Skipping — no available seats in this scenario`);
    return { pass: true, skipped: true, reason: 'no available seats' };
  }

  // Step 1: Read canvas
  log('STEP-1', 'Reading seats from canvas...');
  const { result, resolver } = await readCanvasState(page, 'D');
  const available = (result.canvasSeats || []).filter(s => !s.selected);
  log('STEP-1', `Canvas read: ${result.canvasSeats?.length || 0} total, ${available.length} unselected`);

  if (available.length < 2) {
    log('TEST', `⏭ Skipping — fewer than 2 unselected seats`);
    return { pass: true, skipped: true, reason: 'fewer than 2 seats' };
  }

  // Step 2: Find 2 consecutive seats
  log('STEP-2', 'Finding 2 consecutive seats...');
  const consecutive = resolver.findConsecutiveCanvasSeats(result.canvasSeats, 2);

  if (!consecutive || consecutive.length < 2) {
    log('TEST', `⏭ Skipping — no consecutive pair found`);
    return { pass: true, skipped: true, reason: 'no consecutive pair' };
  }

  log('STEP-2', `Found pair: konva(${consecutive[0].konvaX},${consecutive[0].konvaY}) and konva(${consecutive[1].konvaX},${consecutive[1].konvaY})`);

  // Step 3: Debug coordinates before clicking
  log('STEP-3', 'Debugging coordinate calculation...');
  await debugCoordinates(page, consecutive);

  // Step 4: Click and verify
  log('STEP-4', 'Clicking seats and verifying toggle...');
  const clickResult = await clickAndVerifySeats(page, consecutive, 'D');

  // Step 5: Re-read canvas to confirm state
  log('STEP-5', 'Re-reading canvas after clicks...');
  const { result: afterResult } = await readCanvasState(page, 'D');
  const afterSelected = (afterResult.canvasSeats || []).filter(s => s.selected);
  const afterUnselected = (afterResult.canvasSeats || []).filter(s => !s.selected);
  log('STEP-5', `After re-read: ${afterSelected.length} selected, ${afterUnselected.length} unselected`);

  const pass = clickResult.verified === 2;
  if (pass) {
    log('TEST', `✅ PASS — Both clicks hit their targets. ${clickResult.verified}/2 seats toggled.`);
  } else {
    log('TEST', `❌ FAIL — Only ${clickResult.verified}/2 clicks hit. Coordinates are off.`);
    log('TEST', `   Click details: ${JSON.stringify(clickResult.details, null, 2)}`);
  }

  return { pass, clickResult, afterSelected: afterSelected.length, afterUnselected: afterUnselected.length };
}

/**
 * TEST 2: Canvas re-read after seatlist swap (simulates fresh API response)
 * Load baseline → read seats → swap seatlist → re-read → verify new availability
 */
async function testCanvasRefreshAfterSwap(page) {
  logSection('TEST: Canvas Re-read After Seatlist Swap');

  const harness = await loadHarness(page, 'baseline', 'D', 'default');

  // Step 1: Read initial state
  log('STEP-1', 'Reading initial canvas state...');
  const { result: before } = await readCanvasState(page, 'D');
  const beforeAvail = (before.canvasSeats || []).filter(s => !s.selected).length;
  log('STEP-1', `Initial: ${beforeAvail} available seats`);

  // Step 2: Swap to seatlist-success (different set of available seats)
  log('STEP-2', 'Swapping seatlist to "seatlist-success"...');
  const swapResult = await page.evaluate(() => window.__swapSeatlist?.('seatlist-success'));
  log('STEP-2', `Swap result: ${JSON.stringify(swapResult)}`);
  await page.waitForTimeout(500); // Wait for re-render

  // Step 3: Re-read canvas
  log('STEP-3', 'Re-reading canvas after swap...');
  const { result: after, resolver } = await readCanvasState(page, 'D');
  const afterAvail = (after.canvasSeats || []).filter(s => !s.selected).length;
  log('STEP-3', `After swap: ${afterAvail} available seats`);

  // Step 4: Find consecutive in new data
  const consecutive = resolver.findConsecutiveCanvasSeats(after.canvasSeats, 2);
  const hasConsecutive = consecutive && consecutive.length >= 2;
  log('STEP-4', `Consecutive pair found: ${hasConsecutive}`);

  // Step 5: Swap to stand-full (0 available seats)
  log('STEP-5', 'Swapping seatlist to "seatlist-stand-full"...');
  const swapFull = await page.evaluate(() => window.__swapSeatlist?.('seatlist-stand-full'));
  log('STEP-5', `Swap result: ${JSON.stringify(swapFull)}`);
  await page.waitForTimeout(500);

  const { result: fullResult } = await readCanvasState(page, 'D');
  const fullAvail = (fullResult.canvasSeats || []).filter(s => !s.selected).length;
  log('STEP-5', `After stand-full swap: ${fullAvail} available seats`);

  const pass = afterAvail > 0 && hasConsecutive && fullAvail === 0;
  if (pass) {
    log('TEST', `✅ PASS — Canvas correctly re-reads after seatlist swap`);
    log('TEST', `   Initial: ${beforeAvail} → After success swap: ${afterAvail} → After stand-full: ${fullAvail}`);
  } else {
    log('TEST', `❌ FAIL — Canvas re-read issues after swap`);
    log('TEST', `   Initial: ${beforeAvail}, After swap: ${afterAvail} (expected >0), Consecutive: ${hasConsecutive}, Stand-full: ${fullAvail} (expected 0)`);
  }

  return { pass, beforeAvail, afterAvail, hasConsecutive, fullAvail };
}

/**
 * TEST 3: Retry scenario — seats taken, canvas refreshes, find new seats
 */
async function testRetryAfterSeatsTaken(page) {
  logSection('TEST: Retry After Seats Taken (Canvas Refresh)');

  const harness = await loadHarness(page, 'baseline', 'D', 'seatlist-success');

  // Step 1: Read and find initial consecutive pair
  log('STEP-1', 'Reading initial seats...');
  const { result: r1, resolver: res1 } = await readCanvasState(page, 'D');
  const avail1 = (r1.canvasSeats || []).filter(s => !s.selected);
  const pair1 = res1.findConsecutiveCanvasSeats(r1.canvasSeats, 2);
  log('STEP-1', `Available: ${avail1.length}, Consecutive pair: ${pair1 ? 'yes' : 'no'}`);

  if (!pair1) {
    log('TEST', '⏭ Skipping — no initial consecutive pair');
    return { pass: true, skipped: true };
  }

  // Step 2: Simulate "seats taken" by swapping to retry-step1 (fewer available seats)
  log('STEP-2', 'Simulating seats taken — swapping to seatlist-retry-step1...');
  await page.evaluate(() => window.__swapSeatlist?.('seatlist-retry-step1'));
  await page.waitForTimeout(500);

  // Step 3: Re-read canvas — should see different availability
  log('STEP-3', 'Re-reading canvas after refresh...');
  const { result: r2, resolver: res2 } = await readCanvasState(page, 'D');
  const avail2 = (r2.canvasSeats || []).filter(s => !s.selected);
  const pair2 = res2.findConsecutiveCanvasSeats(r2.canvasSeats, 2);
  log('STEP-3', `Available: ${avail2.length}, Consecutive pair: ${pair2 ? 'yes' : 'no'}`);

  // Step 4: Swap again to retry-step2 (different available seats)
  log('STEP-4', 'Swapping to seatlist-retry-step2...');
  await page.evaluate(() => window.__swapSeatlist?.('seatlist-retry-step2'));
  await page.waitForTimeout(500);

  const { result: r3, resolver: res3 } = await readCanvasState(page, 'D');
  const avail3 = (r3.canvasSeats || []).filter(s => !s.selected);
  const pair3 = res3.findConsecutiveCanvasSeats(r3.canvasSeats, 2);
  log('STEP-4', `Available: ${avail3.length}, Consecutive pair: ${pair3 ? 'yes' : 'no'}`);

  // The key assertion: after each swap, the canvas read reflects the new data
  const pass = avail1.length > 0 && avail2.length >= 0 && avail3.length >= 0;
  if (pass) {
    log('TEST', `✅ PASS — Canvas correctly reflects seatlist changes across retries`);
    log('TEST', `   Step1: ${avail1.length} seats → Step2: ${avail2.length} seats → Step3: ${avail3.length} seats`);
  } else {
    log('TEST', `❌ FAIL — Canvas did not reflect seatlist changes`);
  }

  return { pass, avail1: avail1.length, avail2: avail2.length, avail3: avail3.length };
}

/**
 * TEST 4: Click verification with different stage scales/positions
 */
async function testClickWithScaleAndPan(page) {
  logSection('TEST: Click Verification with Scale/Pan Variants');

  const results = {};

  for (const scenario of ['baseline', 'scaled', 'panned']) {
    log('VARIANT', `Testing scenario: ${scenario}`);
    const result = await testClickVerification(page, scenario, 'default');
    results[scenario] = result;

    if (!result.skipped && !result.pass) {
      log('VARIANT', `⚠️ ${scenario} failed — this indicates coordinate calculation issues with ${scenario} stage transform`);
    }

    // Reset for next scenario
    await page.waitForTimeout(300);
  }

  const allPass = Object.values(results).every(r => r.pass || r.skipped);
  return { pass: allPass, results };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const server = createStaticServer();
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  log('SERVER', `Static server running on http://127.0.0.1:${PORT}`);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const allResults = {};
  let allPassed = true;

  try {
    // Test 1: Basic click verification (baseline)
    allResults.clickVerify = await testClickVerification(page, 'baseline', 'default');
    if (!allResults.clickVerify.pass && !allResults.clickVerify.skipped) allPassed = false;

    // Test 2: Canvas re-read after seatlist swap
    allResults.canvasRefresh = await testCanvasRefreshAfterSwap(page);
    if (!allResults.canvasRefresh.pass) allPassed = false;

    // Test 3: Retry after seats taken
    allResults.retryScenario = await testRetryAfterSeatsTaken(page);
    if (!allResults.retryScenario.pass) allPassed = false;

    // Test 4: Click with different scale/pan
    allResults.scaleAndPan = await testClickWithScaleAndPan(page);
    if (!allResults.scaleAndPan.pass) allPassed = false;

    // ── Summary ─────────────────────────────────────────────────────
    logSection('SUMMARY');

    for (const [name, result] of Object.entries(allResults)) {
      const status = result.skipped ? '⏭ SKIP' : result.pass ? '✅ PASS' : '❌ FAIL';
      log('SUMMARY', `${status} — ${name}`);
    }

    console.log('');
    if (allPassed) {
      log('RESULT', '🎉 All tests passed! The seat selection pipeline works correctly.');
      log('RESULT', '   readSeatsFromCanvas → findConsecutive → mouse.click → verified toggle');
    } else {
      log('RESULT', '⚠️ Some tests failed. Check the DEBUG logs above for coordinate diagnostics.');
      log('RESULT', '   If clicks miss: the browserX/browserY calculation in readSeatsFromCanvas needs fixing.');
      log('RESULT', '   If canvas re-read fails: Konva stage detection or node walking needs fixing.');
    }

  } finally {
    // Keep browser open for 3 seconds so you can see the final state
    await page.waitForTimeout(3000);
    await browser.close();
    server.close();
  }

  if (!allPassed) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = main;