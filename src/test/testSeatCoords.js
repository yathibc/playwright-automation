/**
 * Seat Coordinate Visual Test
 *
 * Loads seat-template and seatlist JSON files, calculates Konva coordinates using
 * the same algorithm as the live website, then generates an HTML file that visually
 * renders the seat layout at different Konva scale levels.
 *
 * This lets you verify that the coordinate calculation is correct by opening the
 * HTML file in a browser and seeing exactly where each seat would be drawn and
 * where the click coordinates would land.
 *
 * Usage:
 *   node src/test/testSeatCoords.js [seat-template.json] [seatlist.json]
 *
 * Defaults:
 *   seat-template: data/seat-template.json
 *   seatlist:      data/seatlist.json
 *
 * Output:
 *   seat_coords_visual.html  — Open in Chrome to see the seat layout
 *   Console table of sample coordinates at different scales
 */

const fs = require('fs');
const path = require('path');

// ── Load data ─────────────────────────────────────────────────────────
const templatePath = process.argv[2] || path.join(__dirname, '../../data/seat-template.json');
const seatlistPath = process.argv[3] || path.join(__dirname, '../../data/seatlist.json');

if (!fs.existsSync(templatePath)) {
  console.error(`Seat template not found: ${templatePath}`);
  process.exit(1);
}

const seatTemplate = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
const seatList = fs.existsSync(seatlistPath) ? JSON.parse(fs.readFileSync(seatlistPath, 'utf-8')) : { result: [] };

console.log(`Loaded ${seatTemplate.length} seats from template`);
console.log(`Loaded ${(seatList.result || []).length} seats from seatlist`);

// ── Sort template (same as KonvaSeatMapResolver) ──────────────────────
const sorted = [...seatTemplate].sort((a, b) => {
  const rA = Number(a.row_Order || 0), rB = Number(b.row_Order || 0);
  if (rA !== rB) return rB - rA;
  const bA = Number(a.box || 0), bB = Number(b.box || 0);
  if (bA !== bB) return bA - bB;
  const sA = Number(a.seat_No || 0), sB = Number(b.seat_No || 0);
  if (sA !== sB) return sA - sB;
  return (Number(a.serial_No || 0)) - (Number(b.serial_No || 0));
});

// ── Calculate Konva coordinates (exact algorithm from website) ────────
let prevRow = '';
let cx = 10, cy = 10;
let maxX = 0, maxY = 0;

const seatsWithCoords = sorted.map(seat => {
  if (prevRow !== seat.row) {
    prevRow = seat.row;
    cx = 10;
    if (seat.row_Gap > 0) cy += seat.row_Gap * 44;
    else cy += 25;
  }
  if (seat.lm > 0) cx += 25 * seat.lm;
  cx += 25;
  if (cx > maxX) maxX = cx;
  if (cy > maxY) maxY = cy;
  return { ...seat, x: cx, y: cy };
});

// ── Mark available seats ──────────────────────────────────────────────
const pool = 'O'; // default pool
const available = new Set();
for (const s of (seatList.result || [])) {
  if (s.status === 'O' && s.bucket === pool) {
    available.add(`${s.stand_Code}-${s.row}-${s.seat_No}`);
  }
}

const seatsMarked = seatsWithCoords.map(s => ({
  ...s,
  isAvailable: available.has(`${s.stand_Code}-${s.row}-${s.seat_No}`)
}));

const availCount = seatsMarked.filter(s => s.isAvailable).length;
console.log(`\nLayout: ${maxX}w x ${maxY}h Konva units`);
console.log(`Available seats (pool="${pool}"): ${availCount} / ${seatsMarked.length}`);

// ── Coordinate table at different scales ──────────────────────────────
const scales = [0.3, 0.5, 0.65, 1.0];
const cssZooms = [1.0, 0.5];
const seatSize = 18;
const centerOffset = seatSize / 2;

// Pick some sample seats
const samples = seatsMarked.filter(s => s.isAvailable).slice(0, 5);
if (samples.length === 0) {
  // If no available seats, just pick first 5
  samples.push(...seatsMarked.slice(0, 5));
}

console.log('\n' + '═'.repeat(120));
console.log('COORDINATE TABLE — How Konva coords map to browser click coords at different scales & CSS zoom levels');
console.log('═'.repeat(120));
console.log('');

// Simulate a canvas at position (0, 50) on the page (typical modal position)
const canvasRect = { left: 0, top: 50 };

for (const cssZoom of cssZooms) {
  console.log(`\n── CSS Zoom: ${cssZoom * 100}% ──────────────────────────────────────────────`);
  console.log(`${'Seat'.padEnd(8)} ${'Konva(x,y)'.padEnd(14)} ${scales.map(s => `Scale ${s}`.padEnd(20)).join(' ')}`);
  console.log('─'.repeat(8 + 14 + scales.length * 21));

  for (const seat of samples) {
    const label = `${seat.row}${seat.seat_No}`;
    const konvaStr = `(${seat.x},${seat.y})`;

    const coords = scales.map(scale => {
      const canvasX = (seat.x + centerOffset) * scale;
      const canvasY = (seat.y + centerOffset) * scale;
      const browserX = (canvasRect.left + canvasX) / cssZoom;
      const browserY = (canvasRect.top + canvasY) / cssZoom;
      return `(${browserX.toFixed(0)},${browserY.toFixed(0)})`;
    });

    console.log(`${label.padEnd(8)} ${konvaStr.padEnd(14)} ${coords.map(c => c.padEnd(20)).join(' ')}`);
  }
}

console.log('\n' + '═'.repeat(120));

// ── Generate HTML visual ──────────────────────────────────────────────
const htmlScales = [0.3, 0.5, 0.65];

let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>RCB Seat Coordinate Visual Test — Stand ${seatTemplate[0]?.stand_Code || '?'}</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #eee; margin: 20px; }
  h1 { color: #e0b050; }
  h2 { color: #a67c00; margin-top: 30px; }
  .info { color: #888; margin-bottom: 10px; }
  .canvas-container { position: relative; border: 1px solid #444; margin: 10px 0; background: #0f0f23; overflow: auto; }
  canvas { display: block; }
  .legend { display: flex; gap: 20px; margin: 10px 0; }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-box { width: 14px; height: 14px; border-radius: 3px; }
  .stats { background: #222; padding: 10px; border-radius: 5px; margin: 10px 0; }
  table { border-collapse: collapse; margin: 10px 0; }
  th, td { border: 1px solid #444; padding: 4px 8px; text-align: right; }
  th { background: #333; color: #e0b050; }
</style>
</head>
<body>
<h1>🏟 RCB Seat Coordinate Visual Test</h1>
<div class="info">Stand Code: ${seatTemplate[0]?.stand_Code || '?'} | Total seats: ${seatsMarked.length} | Available: ${availCount} | Layout: ${maxX}×${maxY} Konva units</div>

<div class="legend">
  <div class="legend-item"><div class="legend-box" style="background:#a67c00"></div> Available</div>
  <div class="legend-item"><div class="legend-box" style="background:#555"></div> Unavailable</div>
  <div class="legend-item"><div class="legend-box" style="background:red; width:6px; height:6px; border-radius:50%"></div> Click target (center)</div>
</div>

<div class="stats">
  <strong>How to read:</strong> Each canvas below shows the seat layout at a different Konva scale (like the slider on the website).
  Gold squares = available seats. Gray = unavailable. Red dots = where <code>mouse.click()</code> would target (center of each available seat).
  Row labels are shown on the left.
</div>
`;

// Seat data as JSON for the HTML
const seatDataJson = JSON.stringify(seatsMarked.map(s => ({
  x: s.x, y: s.y, row: s.row, seat_No: s.seat_No, isAvailable: s.isAvailable, lm: s.lm, row_Gap: s.row_Gap
})));

html += `<script>
const seats = ${seatDataJson};
const maxX = ${maxX};
const maxY = ${maxY};
const seatSize = 18;
const centerOffset = seatSize / 2;

function drawSeatMap(canvasId, scale) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const w = (maxX + 60) * scale;
  const h = (maxY + 40) * scale;
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);

  // Background
  ctx.fillStyle = '#0f0f23';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw seats
  let prevRow = '';
  for (const seat of seats) {
    const sx = seat.x * scale;
    const sy = seat.y * scale;
    const sw = seatSize * scale;
    const sh = seatSize * scale;

    // Seat rectangle
    if (seat.isAvailable) {
      ctx.fillStyle = '#a67c00';
      ctx.strokeStyle = '#a67c00';
    } else {
      ctx.fillStyle = '#555';
      ctx.strokeStyle = '#555';
    }
    ctx.fillRect(sx, sy, sw, sh);

    // Seat number text (only if scale is large enough)
    if (scale >= 0.4) {
      ctx.fillStyle = seat.isAvailable ? '#fff' : '#888';
      ctx.font = Math.max(7, Math.round(10 * scale)) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(seat.seat_No), sx + sw/2, sy + sh/2);
    }

    // Row label (first seat of each row)
    if (seat.row !== prevRow) {
      prevRow = seat.row;
      ctx.fillStyle = '#e0b050';
      ctx.font = Math.max(8, Math.round(12 * scale)) + 'px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(seat.row, sx - 4 * scale, sy + sh/2);
    }

    // Click target dot (red) for available seats
    if (seat.isAvailable) {
      const clickX = (seat.x + centerOffset) * scale;
      const clickY = (seat.y + centerOffset) * scale;
      ctx.beginPath();
      ctx.arc(clickX, clickY, Math.max(2, 3 * scale), 0, Math.PI * 2);
      ctx.fillStyle = 'red';
      ctx.fill();
    }
  }

  // Info text
  ctx.fillStyle = '#888';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Scale: ' + scale + ' | Canvas: ' + canvas.width + 'x' + canvas.height + 'px', 5, canvas.height - 5);
}
</script>
`;

for (const scale of htmlScales) {
  const canvasW = Math.ceil((maxX + 60) * scale);
  const canvasH = Math.ceil((maxY + 40) * scale);
  const canvasId = `seatmap_${String(scale).replace('.', '_')}`;

  html += `
<h2>Konva Scale: ${scale} (Slider position) — Canvas: ${canvasW}×${canvasH}px</h2>
<div class="canvas-container" style="max-height:600px;">
  <canvas id="${canvasId}"></canvas>
</div>
<script>drawSeatMap('${canvasId}', ${scale});</script>
`;
}

// Coordinate comparison table
html += `
<h2>Coordinate Comparison Table (Sample Seats)</h2>
<p class="info">Shows how Konva internal coordinates map to browser click coordinates at different scales. Canvas assumed at (0, 50).</p>
<table>
<tr><th>Seat</th><th>Konva (x,y)</th>`;
for (const s of scales) html += `<th>Scale ${s}<br>Browser (x,y)</th>`;
html += `</tr>`;

for (const seat of samples) {
  html += `<tr><td>${seat.row}${seat.seat_No}</td><td>(${seat.x}, ${seat.y})</td>`;
  for (const scale of scales) {
    const bx = canvasRect.left + (seat.x + centerOffset) * scale;
    const by = canvasRect.top + (seat.y + centerOffset) * scale;
    html += `<td>(${bx.toFixed(1)}, ${by.toFixed(1)})</td>`;
  }
  html += `</tr>`;
}
html += `</table>`;

html += `
<h2>Formula</h2>
<div class="stats">
<pre>
// Konva internal coordinates (from seat template algorithm):
konvaX = accumulated x position (based on lm margins + 25px spacing)
konvaY = accumulated y position (based on row_Gap * 44 or +25 per row)

// Browser click coordinates:
browserX = (canvasRect.left + (konvaX + 9) * konvaScale + stageOffsetX) / cssZoom
browserY = (canvasRect.top  + (konvaY + 9) * konvaScale + stageOffsetY) / cssZoom

Where:
  9 = seatSize/2 = 18/2 (center of the 18×18 seat rectangle)
  konvaScale = Konva stage scaleX/scaleY (from slider, default 0.65)
  stageOffsetX/Y = drag offset (default 0,0 — reset when we set scale)
  cssZoom = CSS zoom level (should be 1.0 — no CSS zoom applied)
  canvasRect = getBoundingClientRect() of the canvas element
</pre>
</div>
</body>
</html>`;

const outputPath = path.join(__dirname, '../../seat_coords_visual.html');
fs.writeFileSync(outputPath, html, 'utf-8');
console.log(`\n✅ Visual test written to: ${outputPath}`);
console.log('   Open in Chrome to see the seat layout at different scales.');
console.log('   Gold = available, Gray = unavailable, Red dots = click targets.\n');
