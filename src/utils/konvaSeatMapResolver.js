 /**
 * KonvaSeatMapResolver
 *
 * Replicates the exact Konva canvas coordinate calculation from the RCB website's
 * React source code. Merges seat-template (layout) with seat-list (availability)
 * to produce clickable browser coordinates for each available seat.
 *
 * Coordinate Algorithm (reverse-engineered from minified index.js `rs` component):
 *   - x starts at 10, y starts at 10
 *   - For each seat in template order:
 *     - If row changes: reset x=10, add (row_Gap * 44) or 25 to y
 *     - If seat.lm > 0: add (25 * lm) to x (left margin / gap)
 *     - Then add 25 to x
 *   - Each seat is an 18x18 Konva Rect at (x, y)
 *
 * Canvas Scaling:
 *   - The Konva Stage uses scaleX/scaleY (default 0.65)
 *   - The Stage is draggable with offset (G.x, G.y)
 *   - We need to convert Konva-internal coords to browser viewport coords
 */
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('KonvaSeatMapResolver');

class KonvaSeatMapResolver {
  /**
   * @param {Object} options
   * @param {string} options.pool - User pool/bucket (e.g., 'O' for Online)
   */
  constructor(options = {}) {
    this.pool = options.pool || 'O';
    this.resolvedSeats = [];    // All seats with calculated x,y
    this.availableSeats = [];   // Only available seats (status=O, matching pool)
    this.layoutWidth = 0;
    this.layoutHeight = 0;
  }

  /**
   * Main entry: merge seat-template + seat-list and calculate coordinates.
   *
   * @param {Array} seatTemplate - Array of seat layout objects from S3 JSON
   * @param {Object} seatListResponse - API response { status, result: [...] }
   * @returns {Array} Array of seat objects with { x, y, row, seat_No, stand_Code, available, i_Id, ... }
   */
  resolve(seatTemplate, seatListResponse) {
    if (!seatTemplate || !Array.isArray(seatTemplate) || seatTemplate.length === 0) {
      logger.warn('Empty or invalid seat template');
      return [];
    }

    const seatList = seatListResponse?.result || [];

    // Filter available seats from seat-list (status=O means Open, matching user pool)
    const availableFromApi = seatList.filter(s => s.status === 'O' && s.bucket === this.pool);
    logger.info(`Seat-list has ${seatList.length} total, ${availableFromApi.length} available for pool "${this.pool}"`);

    // Normalize template ordering before coordinate calculation.
    // The website's renderer depends on template order when walking seats row-by-row.
    // If intercepted template rows arrive unsorted, the calculated y positions drift,
    // which can make a logged/API row like "O" click on a visually different row.
    const normalizedTemplate = [...seatTemplate].sort((a, b) => {
      const rowOrderA = Number(a.row_Order || 0);
      const rowOrderB = Number(b.row_Order || 0);
      if (rowOrderA !== rowOrderB) return rowOrderB - rowOrderA;

      const boxA = Number(a.box || 0);
      const boxB = Number(b.box || 0);
      if (boxA !== boxB) return boxA - boxB;

      const seatNoA = Number(a.seat_No || 0);
      const seatNoB = Number(b.seat_No || 0);
      if (seatNoA !== seatNoB) return seatNoA - seatNoB;

      const serialA = Number(a.serial_No || 0);
      const serialB = Number(b.serial_No || 0);
      return serialA - serialB;
    });

    // Merge availability info into template
    const mergedTemplate = normalizedTemplate.map(templateSeat => {
      const match = availableFromApi.find(apiSeat =>
        apiSeat.stand_Code === templateSeat.stand_Code &&
        apiSeat.box === templateSeat.box &&
        apiSeat.row === templateSeat.row &&
        apiSeat.seat_No === templateSeat.seat_No
      );

      if (match) {
        return {
          ...templateSeat,
          i_Id: match.i_Id,
          eventId: match.eventId,
          status: match.status,
          bucket: match.bucket
        };
      }
      return { ...templateSeat };
    });

    // Calculate Konva canvas coordinates using the exact algorithm from the source
    this.resolvedSeats = this._calculateCoordinates(mergedTemplate);

    // Filter to only available seats
    this.availableSeats = this.resolvedSeats.filter(s =>
      s.bucket === this.pool && s.status === 'O'
    );

    logger.info(`Resolved ${this.resolvedSeats.length} total seats, ${this.availableSeats.length} available,
     layout: ${this.layoutWidth}x${this.layoutHeight}`);

    if (this.availableSeats.length > 0) {
      const sample = this.availableSeats.slice(0, 5)
        .map(seat => `${seat.row}${seat.seat_No}(rowOrder=${seat.row_Order}, x=${seat.x}, y=${seat.y})`)
        .join(', ');
      logger.info(`Sample available seat mapping: ${sample}`);
    }

    return this.resolvedSeats;
  }

  /**
   * Replicate the exact coordinate calculation from the website's Konva rendering code.
   *
   * From the decompiled source (rs component):
   *   let prevRow = "";
   *   let mA = 10;  // x accumulator
   *   let HA = 10;  // y accumulator
   *   W = p.map(seat => {
   *     if (prevRow !== seat.row) {
   *       prevRow = seat.row;
   *       mA = 10;
   *       seat.row_Gap > 0 ? HA = HA + seat.row_Gap * 44 : HA = HA + 25;
   *     }
   *     if (seat.lm > 0) mA = mA + 25 * seat.lm;
   *     mA = mA + 25;
   *     // track max width/height
   *     return { ...seat, x: mA, y: HA };
   *   });
   */
  _calculateCoordinates(seats) {
    let prevRow = '';
    let x = 10;
    let y = 10;
    let maxX = 0;
    let maxY = 0;

    const result = seats.map(seat => {
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

      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      return {
        ...seat,
        x,
        y
      };
    });

    this.layoutWidth = maxX;
    this.layoutHeight = maxY;

    return result;
  }

  /**
   * Convert Konva-internal seat coordinates to browser viewport coordinates.
   *
   * The Konva Stage applies:
   *   - scale (default 0.65)
   *   - drag offset (stageX, stageY) — starts at (0, 0)
   *   - The canvas element itself has a bounding rect on the page
   *
   * When browser zoom is applied (e.g., 50%), getBoundingClientRect() returns the
   * VISUAL position on screen after zoom has been applied.
   *
   * In practice for this flow, Playwright mouse.click() should use the same viewport
   * coordinates returned from the zoomed canvas bounding rect. Dividing by zoom pushes
   * clicks far outside the seat map, so we keep click coords aligned with the visual
   * marker position.
   *
   * @param {Object} seat - Seat with .x and .y (Konva internal coords)
   * @param {Object} canvasRect - { left, top } from canvas.getBoundingClientRect()
   * @param {number} scale - Konva stage scale (default 0.65)
   * @param {Object} stageOffset - { x, y } drag offset of the stage (default {0,0})
   * @param {number} browserZoom - CSS zoom level applied to body (default 1.0)
   * @returns {{ browserX: number, browserY: number }}
   */
  toBrowserCoords(seat, canvasRect, scale = 0.65, stageOffset = { x: 0, y: 0 },
                  browserZoom = 1.0) {
    const seatSize = 18;
    const centerOffset = seatSize / 2;

    // Canvas rect is already reported in the page's current CSS pixel coordinate system.
    // Playwright mouse.click() also expects viewport CSS pixels, so we should use those
    // values directly. Applying the zoom factor again shifts the click target away from
    // the actual rendered seat position.
    const markerX = canvasRect.left + ((seat.x + centerOffset) * scale) + stageOffset.x;
    const markerY = canvasRect.top + ((seat.y + centerOffset) * scale) + stageOffset.y;

    const browserX = markerX;
    const browserY = markerY;

    return { browserX, browserY, markerX, markerY };
  }

  /**
   * Find consecutive seat pairs in the same row from available seats.
   * Returns array of [seat1, seat2] pairs sorted by row preference.
   *
   * @param {string|null} preferredRow - Optional preferred row letter
   * @returns {Array<[Object, Object]>}
   */
  findConsecutivePairs(preferredRow = null) {
    // Group available seats by row
    const byRow = {};
    for (const seat of this.availableSeats) {
      const row = seat.row || 'unknown';
      if (!byRow[row]) byRow[row] = [];
      byRow[row].push(seat);
    }

    const pairs = [];

    for (const row of Object.keys(byRow)) {
      const rowSeats = byRow[row]
        .filter(s => !isNaN(parseInt(s.seat_No)))
        .sort((a, b) => parseInt(a.seat_No) - parseInt(b.seat_No));

      for (let i = 0; i < rowSeats.length - 1; i++) {
        const current = rowSeats[i];
        const next = rowSeats[i + 1];
        if (parseInt(next.seat_No) === parseInt(current.seat_No) + 1) {
          pairs.push([current, next]);
        }
      }
    }

    // Shuffle pairs randomly so parallel browsers pick different seats
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }

    // If preferred row specified, move those pairs to front (but still randomized within)
    if (preferredRow) {
      const preferred = pairs.filter(p => p[0].row === preferredRow);
      const others = pairs.filter(p => p[0].row !== preferredRow);
      pairs.length = 0;
      pairs.push(...preferred, ...others);
    }

    logger.info(`Found ${pairs.length} consecutive pairs across ${Object.keys(byRow).length} rows (randomized)`);
    return pairs;
  }

  /**
   * Find N consecutive seats in the same row.
   * Picks RANDOMLY from all available consecutive groups to avoid
   * parallel browser instances selecting the same seats.
   *
   * @param {number} count - Number of consecutive seats needed
   * @returns {Array<Object>|null} Array of N seats or null
   */
  findConsecutiveSeats(count = 2) {
    const byRow = {};
    for (const seat of this.availableSeats) {
      const row = seat.row || 'unknown';
      if (!byRow[row]) byRow[row] = [];
      byRow[row].push(seat);
    }

    // Collect ALL consecutive groups across all rows
    const allGroups = [];

    for (const row of Object.keys(byRow)) {
      const rowSeats = byRow[row]
        .filter(s => !isNaN(parseInt(s.seat_No)))
        .sort((a, b) => parseInt(a.seat_No) - parseInt(b.seat_No));

      for (let i = 0; i <= rowSeats.length - count; i++) {
        let consecutive = true;
        for (let j = 1; j < count; j++) {
          const nextSeat = rowSeats[i + j];
          // Check sequential seat number AND no large physical gap (lm <= 1 means adjacent)
          if (parseInt(nextSeat.seat_No) !== parseInt(rowSeats[i].seat_No) + j || (nextSeat.lm || 0) > 1) {
            consecutive = false;
            break;
          }
        }
        if (consecutive) {
          allGroups.push(rowSeats.slice(i, i + count));
        }
      }
    }

    if (allGroups.length === 0) {
      logger.info('No consecutive seat groups found');
      return null;
    }

    // Pick a RANDOM group to avoid parallel browser conflicts
    const randomIndex = Math.floor(Math.random() * allGroups.length);
    const selected = allGroups[randomIndex];
    logger.info(`Found ${allGroups.length} consecutive groups, randomly picked group ${randomIndex + 1}:
     Row ${selected[0].row}, seats ${selected.map(s => s.seat_No).join('-')}`);
    return selected;
  }

  /**
   * Get the canvas bounding rect and current Konva stage state from the browser.
   * Must be called while the seat map modal is open.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<{ canvasRect: DOMRect, scale: number, stageOffset: {x,y} }>}
   */
  async getCanvasState(page) {
    return await page.evaluate(() => {
      // Find the Konva canvas element (the seat map modal uses a full-screen Stage)
      const canvasCandidates = Array.from(document.querySelectorAll('.konvajs-content canvas, canvas'));
      const canvasEl = canvasCandidates
        .filter(canvas => {
          const rect = canvas.getBoundingClientRect();
          return rect.width > 50 && rect.height > 50;
        })
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return (rectB.width * rectB.height) - (rectA.width * rectA.height);
        })[0];
      if (!canvasEl) return null;

      const rect = canvasEl.getBoundingClientRect();

      // Try to read Konva stage state from the Konva global
      let scale = 0.65;
      let stageX = 0;
      let stageY = 0;

      try {
        // Konva stores stages globally
        if (window.Konva && window.Konva.stages && window.Konva.stages.length > 0) {
          const stages = window.Konva.stages;
          const matchedStage = stages.find(stage => {
            try {
              const stageCanvas = stage.container()?.querySelector('canvas');
              return stageCanvas === canvasEl;
            } catch (_) {
              return false;
            }
          });

          const stage = matchedStage || stages.find(stage => {
            try {
              const stageCanvas = stage.container()?.querySelector('canvas');
              const stageRect = stageCanvas?.getBoundingClientRect();
              return stageRect && Math.abs(stageRect.width - rect.width) < 2 && Math.abs(stageRect.height - rect.height) < 2;
            } catch (_) {
              return false;
            }
          }) || stages[0];

          scale = stage.scaleX() || 0.65;
          stageX = stage.x() || 0;
          stageY = stage.y() || 0;
        }
      } catch (e) {
        // Konva may not expose stages globally in production builds
      }

      return {
        canvasRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        scale,
        stageOffset: { x: stageX, y: stageY }
      };
    });
  }

  /**
   * High-level: resolve seats and return them as objects compatible with SeatSelector.
   * Each seat object has { x, y, row, number, stand, available, i_Id, element: null }.
   * The x,y are BROWSER coordinates ready for page.mouse.click(x, y).
   *
   * @param {Array} seatTemplate
   * @param {Object} seatListResponse
   * @param {import('playwright').Page} page
   * @param {number} browserZoom - CSS zoom level (default 1.0, use 0.5 for 50%)
   * @returns {Promise<Array>} Seat objects with browser coordinates
   */
  async resolveWithBrowserCoords(seatTemplate,
                                 seatListResponse, page, browserZoom = 1.0) {
    this.resolve(seatTemplate, seatListResponse);

    if (this.availableSeats.length === 0) {
      logger.warn('No available seats to resolve browser coordinates for');
      return [];
    }

    // Get canvas position and Konva stage state
    const canvasState = await this.getCanvasState(page);
    if (!canvasState) {
      logger.error('Could not find canvas element on page');
      return [];
    }

    logger.info(`Canvas state: rect=(${canvasState.canvasRect.left},${canvasState.canvasRect.top}),
    scale=${canvasState.scale}, offset=(${canvasState.stageOffset.x},${canvasState.stageOffset.y}),
     browserZoom=${browserZoom}`);

    // Convert each available seat to browser coordinates (accounting for zoom)
    const browserSeats = this.availableSeats.map(seat => {
      const { browserX, browserY, markerX, markerY } = this.toBrowserCoords(
        seat,
        canvasState.canvasRect,
        canvasState.scale,
        canvasState.stageOffset,
        browserZoom
      );

      return {
        // SeatSelector-compatible fields
        x: browserX,
        y: browserY,
        row: seat.row,
        number: String(seat.seat_No),
        stand: seat.stand_Code,
        available: true,
        // Extra Konva-specific fields
        i_Id: seat.i_Id,
        eventId: seat.eventId,
        konvaX: seat.x,
        konvaY: seat.y,
        markerX,
        markerY,
        box: seat.box,
        // No DOM element for canvas seats
        element: null
      };
    });

    logger.info(`Resolved ${browserSeats.length} seats with browser coordinates`);
    return browserSeats;
  }
}

module.exports = KonvaSeatMapResolver;