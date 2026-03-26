/**
 * Seat Layout Visualizer — ASCII Dot Map Test
 *
 * Reads the seat-template JSON and renders an ASCII representation of the seat layout
 * using the exact same coordinate algorithm as the Konva canvas on the RCB website.
 *
 * Usage:
 *   node src/test/testSeatLayout.js [path-to-seat-template.json]
 *
 * Default: reads ../../seeat-template-response.json
 *
 * Output: Writes seat_layout.txt with a visual dot map of all seats.
 *         Each seat is shown as a dot, with row labels on the left.
 *         Gaps (lm > 0) are shown as spaces.
 *         Row gaps (row_Gap > 0) are shown as extra blank lines.
 */

const fs = require('fs');
const path = require('path');

// ── Load seat template ────────────────────────────────────────────────
const templatePath = process.argv[2] || path.join(__dirname, '../../../seeat-template-response.json');

if (!fs.existsSync(templatePath)) {
  console.error(`Seat template file not found: ${templatePath}`);
  process.exit(1);
}

const seatTemplate = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
console.log(`Loaded ${seatTemplate.length} seats from ${templatePath}`);

// ── Apply the exact Konva coordinate algorithm ────────────────────────
// From index.js (rs component):
//   let prevRow = "", x = 10, y = 10;
//   seats.map(seat => {
//     if (prevRow !== seat.row) { prevRow = seat.row; x = 10; seat.row_Gap > 0 ? y += seat.row_Gap * 44 : y += 25; }
//     if (seat.lm > 0) x += 25 * seat.lm;
//     x += 25;
//     return { ...seat, x, y };
//   });

let prevRow = '';
let x = 10;
let y = 10;

const seatsWithCoords = seatTemplate.map(seat => {
  if (prevRow !== seat.row) {
    prevRow = seat.row;
    x = 10;
    if (seat.row_Gap > 0) {
      y = y + seat.row_Gap * 44;
    } else {
      y = y + 25;
    }
  }

  if (seat.lm > 0) {
    x = x + 25 * seat.lm;
  }

  x = x + 25;

  return { ...seat, x, y };
});

// ── Build the ASCII grid ──────────────────────────────────────────────
// Each seat occupies a cell. We use the x coordinate divided by 25 as the column index.
// The y coordinate divided by 25 gives the approximate row index.

// Find bounds
const maxX = Math.max(...seatsWithCoords.map(s => s.x));
const maxY = Math.max(...seatsWithCoords.map(s => s.y));
const minX = Math.min(...seatsWithCoords.map(s => s.x));

// Scale: each "cell" is 25 units wide in Konva coords
const cellSize = 25;
const cols = Math.ceil(maxX / cellSize) + 2;

// Group seats by their y coordinate (each unique y = one visual row)
const rowMap = new Map();
for (const seat of seatsWithCoords) {
  if (!rowMap.has(seat.y)) {
    rowMap.set(seat.y, { row: seat.row, seats: [] });
  }
  rowMap.get(seat.y).seats.push(seat);
}

// Sort rows by y (top to bottom)
const sortedYs = [...rowMap.keys()].sort((a, b) => a - b);

// ── Render ASCII ──────────────────────────────────────────────────────
const lines = [];
lines.push('╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗');
lines.push('║                           RCB SEAT LAYOUT VISUALIZER — Stand Code: ' + (seatTemplate[0]?.stand_Code || '?') + '                            ║');
lines.push('║                           Algorithm: Konva coordinate calculation                                  ║');
lines.push('║                           ● = seat position, spaces = gaps (lm)                                    ║');
lines.push('╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝');
lines.push('');

// Column header (seat numbers for reference)
const headerSeats = rowMap.get(sortedYs[sortedYs.length - 1])?.seats || [];
if (headerSeats.length > 0) {
  // Show column numbers at the top
  let colHeader = '       '; // padding for row label
  const maxSeatNo = Math.max(...seatsWithCoords.map(s => s.seat_No));
  for (let i = 1; i <= maxSeatNo; i++) {
    if (i % 5 === 0) {
      colHeader += String(i).padStart(2, ' ');
    } else {
      colHeader += '  ';
    }
  }
  lines.push(colHeader);
}

let prevY = null;
for (const yCoord of sortedYs) {
  const rowData = rowMap.get(yCoord);

  // Add extra blank lines for row_Gap
  if (prevY !== null) {
    const gap = yCoord - prevY;
    if (gap > 30) { // row_Gap > 0 creates larger gaps
      lines.push('       │' + '─'.repeat(cols) + '│  (gap)');
    }
  }
  prevY = yCoord;

  // Build the row line
  const rowLabel = rowData.row.padStart(4, ' ');

  // Create a character array for this row
  const rowChars = new Array(cols + 1).fill(' ');

  for (const seat of rowData.seats) {
    const col = Math.round(seat.x / cellSize);
    if (col >= 0 && col < rowChars.length) {
      rowChars[col] = '●';
    }
  }

  // Build the line with row label
  const seatLine = rowChars.join(' ');
  const seatCount = rowData.seats.length;
  const firstSeat = Math.min(...rowData.seats.map(s => s.seat_No));
  const lastSeat = Math.max(...rowData.seats.map(s => s.seat_No));

  lines.push(`${rowLabel} │${seatLine}│ ${seatCount} seats (${firstSeat}-${lastSeat})`);
}

lines.push('');
lines.push('── Summary ──────────────────────────────────────────────────────────────────');
lines.push(`Total seats: ${seatTemplate.length}`);
lines.push(`Rows: ${sortedYs.length} (${[...new Set(seatTemplate.map(s => s.row))].join(', ')})`);
lines.push(`Stand code: ${seatTemplate[0]?.stand_Code || 'unknown'}`);
lines.push(`Layout size: ${maxX}w x ${maxY}h (Konva units)`);
lines.push(`Seat size: 18x18 px each, spaced 25px apart`);
lines.push('');

// ── Also create a detailed coordinate dump ────────────────────────────
lines.push('── Coordinate Details (first 3 seats per row) ──────────────────────────────');
for (const yCoord of sortedYs) {
  const rowData = rowMap.get(yCoord);
  const samples = rowData.seats.slice(0, 3);
  const sampleStr = samples.map(s => `${s.row}${s.seat_No}@(${s.x},${s.y}) lm=${s.lm}`).join('  ');
  lines.push(`  Row ${rowData.row.padStart(3)}: y=${yCoord}  ${sampleStr}  ... (${rowData.seats.length} total)`);
}

// ── Write output ──────────────────────────────────────────────────────
const outputPath = path.join(__dirname, '../../../seat_layout.txt');
const output = lines.join('\n');
fs.writeFileSync(outputPath, output, 'utf-8');

console.log(`\nSeat layout written to: ${outputPath}`);
console.log(`Total seats: ${seatTemplate.length}, Rows: ${sortedYs.length}`);
console.log(`Layout: ${maxX}w x ${maxY}h Konva units\n`);

// Also print to console
console.log(output);
