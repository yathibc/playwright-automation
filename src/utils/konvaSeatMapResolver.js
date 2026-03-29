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
   *   - scale (scaleX/scaleY, controlled by the in-page slider, default 0.65)
   *   - drag offset (stageX, stageY) — starts at (0, 0)
   *   - The canvas element itself has a bounding rect on the page
   *
   * CSS zoom interaction:
   *   When CSS `zoom` is applied to the page (e.g., 50%), `getBoundingClientRect()`
   *   returns coordinates in the *zoomed* CSS pixel space (values are scaled down).
   *   However, Playwright's `page.mouse.click(x, y)` operates in the *layout viewport*
   *   coordinate system (unzoomed). So we must divide the rect values by the CSS zoom
   *   factor to get the correct click position.
   *
   *   IMPORTANT: The Konva stage's own scale (from the slider) is separate from CSS zoom.
   *   The stage scale affects how Konva-internal coords map to canvas pixels.
   *   CSS zoom affects how canvas pixels map to viewport pixels.
   *
   * The stageOffset (from dragging) is already in scaled canvas space, so it gets
   * divided by CSS zoom along with everything else.
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

    // Calculate the seat's position on the canvas in CSS-zoomed pixel space.
    // The stage offset (from dragging) is already in the scaled coordinate system.
    // The seat's Konva coords are multiplied by the Konva stage scale to get canvas pixels.
    const canvasX = (seat.x + centerOffset) * scale + stageOffset.x;
    const canvasY = (seat.y + centerOffset) * scale + stageOffset.y;

    // getBoundingClientRect() returns values in CSS-zoomed space.
    // Playwright mouse.click() expects layout viewport coordinates (unzoomed).
    // When CSS zoom = 1.0, these are the same. When zoom = 0.5, rect values are
    // half of the true layout position, so we divide by zoom to compensate.
    const zoom = browserZoom || 1.0;
    const browserX = (canvasRect.left + canvasX) / zoom;
    const browserY = (canvasRect.top + canvasY) / zoom;

    // markerX/Y are the visual position in CSS-zoomed space (for debugging)
    const markerX = canvasRect.left + canvasX;
    const markerY = canvasRect.top + canvasY;

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
   * Set the Konva stage scale programmatically via the browser.
   * This is equivalent to using the in-page zoom slider.
   * A lower scale (e.g., 0.3) fits all seats in view; higher (e.g., 1.0) zooms in.
   *
   * @param {import('playwright').Page} page
   * @param {number} targetScale - Desired scale (0.3 = zoomed out, 1.2 = zoomed in)
   * @returns {Promise<boolean>} true if scale was set successfully
   */
  async setKonvaStageScale(page, targetScale = 0.3) {
    const result = await page.evaluate((scale) => {
      try {
        if (!window.Konva || !window.Konva.stages || window.Konva.stages.length === 0) {
          return { success: false, reason: 'No Konva stages found' };
        }

        const stages = window.Konva.stages;

        // Find the seat-map stage: prefer the one inside a modal, or the largest one
        let seatStage = null;

        // Strategy 1: Find stage inside a modal dialog
        for (const stage of stages) {
          try {
            const container = stage.container();
            if (container && container.closest('[role="dialog"], .chakra-modal__body, .chakra-modal__content')) {
              seatStage = stage;
              break;
            }
          } catch (_) {}
        }

        // Strategy 2: Find the stage with the largest canvas (seat maps are big)
        if (!seatStage) {
          let maxArea = 0;
          for (const stage of stages) {
            try {
              const w = stage.width() || 0;
              const h = stage.height() || 0;
              if (w * h > maxArea) {
                maxArea = w * h;
                seatStage = stage;
              }
            } catch (_) {}
          }
        }

        if (!seatStage) {
          seatStage = stages[stages.length - 1]; // fallback: last stage (modal opens last)
        }

        const oldScale = seatStage.scaleX();
        seatStage.scaleX(scale);
        seatStage.scaleY(scale);
        // Reset drag offset so the zoomed-out layout starts from origin
        seatStage.x(0);
        seatStage.y(0);
        // Use synchronous draw() instead of batchDraw() to ensure the canvas
        // is fully re-rendered before we read coordinates.
        // batchDraw() uses requestAnimationFrame (async) which causes a race condition.
        seatStage.draw();

        // Verify the scale was actually applied
        const verifiedScale = seatStage.scaleX();

        return { success: true, oldScale, newScale: scale, verifiedScale, stageIndex: stages.indexOf(seatStage) };
      } catch (e) {
        return { success: false, reason: e.message };
      }
    }, targetScale);

    if (result?.success) {
      logger.info(`Konva stage scale set: ${result.oldScale} → ${result.newScale} (stage index ${result.stageIndex})`);
    } else {
      logger.warn(`Failed to set Konva stage scale: ${result?.reason || 'unknown'}`);
    }

    return result?.success || false;
  }

  /**
   * Get the canvas bounding rect and current Konva stage state from the browser.
   * Must be called while the seat map modal is open.
   *
   * Targets the seat-map canvas specifically — prefers the canvas inside a modal
   * dialog (the seat selection popup) over the stand-map canvas in the background.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<{ canvasRect: DOMRect, scale: number, stageOffset: {x,y}, cssZoom: number }>}
   */
  async getCanvasState(page) {
    return await page.evaluate(() => {
      // Prefer canvas inside the seat selection modal
      let canvasEl = null;

      // Strategy 1: Find canvas inside a modal/dialog
      const modalSelectors = [
        '.chakra-modal__body .konvajs-content canvas',
        '.chakra-modal__content .konvajs-content canvas',
        '[role="dialog"] .konvajs-content canvas',
        '.chakra-modal__body canvas',
        '[role="dialog"] canvas'
      ];

      for (const sel of modalSelectors) {
        const candidates = Array.from(document.querySelectorAll(sel));
        const visible = candidates.filter(c => {
          const r = c.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        if (visible.length > 0) {
          canvasEl = visible[0];
          break;
        }
      }

      // Strategy 2: Fallback to largest visible canvas
      if (!canvasEl) {
        const allCanvases = Array.from(document.querySelectorAll('.konvajs-content canvas, canvas'));
        canvasEl = allCanvases
          .filter(c => {
            const r = c.getBoundingClientRect();
            return r.width > 50 && r.height > 50;
          })
          .sort((a, b) => {
            const rA = a.getBoundingClientRect();
            const rB = b.getBoundingClientRect();
            return (rB.width * rB.height) - (rA.width * rA.height);
          })[0];
      }

      if (!canvasEl) return null;

      const rect = canvasEl.getBoundingClientRect();

      // Detect CSS zoom applied to the page
      let cssZoom = 1.0;
      try {
        const bodyZoom = parseFloat(window.getComputedStyle(document.body).zoom);
        const htmlZoom = parseFloat(window.getComputedStyle(document.documentElement).zoom);
        if (!isNaN(bodyZoom) && bodyZoom > 0) cssZoom = bodyZoom;
        else if (!isNaN(htmlZoom) && htmlZoom > 0) cssZoom = htmlZoom;
      } catch (_) {}

      // Try to read Konva stage state from the Konva global
      let scale = 0.65;
      let stageX = 0;
      let stageY = 0;

      try {
        if (window.Konva && window.Konva.stages && window.Konva.stages.length > 0) {
          const stages = window.Konva.stages;

          // Match the stage whose container holds our target canvas
          let stage = stages.find(s => {
            try {
              const stageCanvas = s.container()?.querySelector('canvas');
              return stageCanvas === canvasEl;
            } catch (_) {
              return false;
            }
          });

          // Fallback: match by bounding rect size
          if (!stage) {
            stage = stages.find(s => {
              try {
                const stageCanvas = s.container()?.querySelector('canvas');
                const sr = stageCanvas?.getBoundingClientRect();
                return sr && Math.abs(sr.width - rect.width) < 5 && Math.abs(sr.height - rect.height) < 5;
              } catch (_) {
                return false;
              }
            });
          }

          // Fallback: last stage (modal stage is created after stand-map stage)
          if (!stage) {
            stage = stages[stages.length - 1];
          }

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
        stageOffset: { x: stageX, y: stageY },
        cssZoom
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
   * @param {boolean} shouldSetScale - Whether to set the Konva stage scale (true on first attempt,
   *   false on retries within the same stand to avoid interfering with React's rendering)
   * @returns {Promise<Array>} Seat objects with browser coordinates
   */
  async resolveWithBrowserCoords(seatTemplate,
                                 seatListResponse, page, browserZoom = 1.0,
                                 shouldSetScale = true) {
    this.resolve(seatTemplate, seatListResponse);

    if (this.availableSeats.length === 0) {
      logger.warn('No available seats to resolve browser coordinates for');
      return [];
    }

    // Zoom out the Konva stage so all seats are visible (equivalent to slider at min).
    // Use a scale that fits the layout within the modal viewport.
    // The seat selection modal is typically ~1366px wide, ~533px tall.
    // We calculate the ideal scale to fit the layout, clamped to the slider range [0.3, 1.2].
    const modalWidth = await page.evaluate(() => {
      const modal = document.querySelector('.chakra-modal__body, [role="dialog"]');
      return modal ? modal.clientWidth : window.innerWidth;
    });
    const idealScale = Math.max(0.3, Math.min(1.2,
      modalWidth / (this.layoutWidth + 60)  // +60 for row labels padding
    ));
    const fitScale = Math.min(idealScale, 0.3); // cap at 0.3 to ensure all seats visible

    if (shouldSetScale) {
      // First attempt in this stand: set the Konva stage scale to zoom out.
      // This calls stage.draw() which forces a synchronous canvas redraw.
      logger.info(`Layout ${this.layoutWidth}x${this.layoutHeight}, modal width ~${modalWidth}, setting Konva scale ${fitScale.toFixed(2)}`);
      await this.setKonvaStageScale(page, fitScale);

      // Wait for Konva to fully re-render after scale change.
      // stage.draw() is synchronous for the Konva layer, but the browser still needs
      // to composite and update the layout (~1-2 frames).
      await page.waitForTimeout(400);
    } else {
      // Retry attempt within the same stand: do NOT re-set the scale.
      // The scale was already set on the first attempt. Re-setting it here would call
      // stage.draw() which can race with React's own re-rendering of the Konva nodes
      // after a fresh seatlist response, causing the canvas to show stale seat states.
      // Instead, just wait briefly for React to finish its render cycle.
      logger.info(`Retry attempt — skipping scale change, waiting for React render to settle`);
      await page.waitForTimeout(300);
    }

    // Canvas stability check: read the canvas state twice with a gap to ensure
    // React has finished rendering and the canvas is not mid-transition.
    let canvasState = await this.getCanvasState(page);
    if (!canvasState) {
      logger.error('Could not find canvas element on page');
      return [];
    }

    // Verify canvas is stable by reading state again after a short delay
    await page.waitForTimeout(150);
    const canvasState2 = await this.getCanvasState(page);
    if (canvasState2) {
      const rectDrift = Math.abs(canvasState.canvasRect.left - canvasState2.canvasRect.left) +
                        Math.abs(canvasState.canvasRect.top - canvasState2.canvasRect.top);
      const scaleDrift = Math.abs(canvasState.scale - canvasState2.scale);
      if (rectDrift > 2 || scaleDrift > 0.01) {
        logger.warn(`Canvas still settling (rect drift=${rectDrift.toFixed(1)}px, scale drift=${scaleDrift.toFixed(3)}) — waiting extra`);
        await page.waitForTimeout(300);
        canvasState = await this.getCanvasState(page);
        if (!canvasState) {
          logger.error('Could not find canvas element on page after stability wait');
          return [];
        }
      } else {
        // Use the second (more recent) reading
        canvasState = canvasState2;
      }
    }

    // On first attempt, verify the scale we set matches what we read back
    if (shouldSetScale && Math.abs(canvasState.scale - fitScale) > 0.01) {
      logger.warn(`Scale mismatch: set ${fitScale} but read ${canvasState.scale} — waiting and retrying`);
      await page.waitForTimeout(300);
      canvasState = await this.getCanvasState(page);
      if (!canvasState) {
        logger.error('Could not find canvas element on page after retry');
        return [];
      }
    }

    // Use the CSS zoom detected from the page itself (more reliable than passed-in value)
    const effectiveZoom = canvasState.cssZoom || browserZoom || 1.0;

    logger.info(`Canvas state: rect=(${canvasState.canvasRect.left.toFixed(1)},${canvasState.canvasRect.top.toFixed(1)}` +
      ` ${canvasState.canvasRect.width.toFixed(0)}x${canvasState.canvasRect.height.toFixed(0)}),` +
      ` konvaScale=${canvasState.scale}, offset=(${canvasState.stageOffset.x},${canvasState.stageOffset.y}),` +
      ` cssZoom=${effectiveZoom}`);

    // Convert each available seat to browser coordinates (accounting for CSS zoom)
    const browserSeats = this.availableSeats.map(seat => {
      const { browserX, browserY, markerX, markerY } = this.toBrowserCoords(
        seat,
        canvasState.canvasRect,
        canvasState.scale,
        canvasState.stageOffset,
        effectiveZoom
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

    // Log a few sample coordinates for debugging
    if (browserSeats.length > 0) {
      const samples = browserSeats.slice(0, 3).map(s =>
        `${s.row}${s.number}: konva(${s.konvaX},${s.konvaY}) → browser(${s.x.toFixed(1)},${s.y.toFixed(1)})`
      ).join(' | ');
      logger.info(`Sample browser coords: ${samples}`);
    }

    logger.info(`Resolved ${browserSeats.length} seats with browser coordinates`);
    return browserSeats;
  }

  /**
   * Read available seats directly from the live Konva canvas nodes.
   * This bypasses API interception entirely — reads what's actually rendered on screen.
   *
   * The website renders available seats as Konva Rect nodes with:
   *   - stroke: "#a67c00" (gold border = available for user's pool)
   *   - fill: "#ffffff" (white = unselected) or "#a67c00" (gold = selected)
   * Unavailable seats have stroke: "#ccc" and fill: "#ccc"
   *
   * @param {import('playwright').Page} page
   * @param {number} browserZoom - CSS zoom level (default 1.0)
   * @returns {Promise<{canvasSeats: Array, stageInfo: Object}>}
   */
  async readSeatsFromCanvas(page, browserZoom = 1.0) {
    const result = await page.evaluate(() => {
      try {
        if (!window.Konva || !window.Konva.stages || window.Konva.stages.length === 0) {
          return { error: 'No Konva stages found', canvasSeats: [], stageInfo: null };
        }

        const stages = window.Konva.stages;

        // Find the seat-map stage (inside modal)
        let seatStage = null;
        for (const stage of stages) {
          try {
            const container = stage.container();
            if (container && container.closest('[role="dialog"], .chakra-modal__body, .chakra-modal__content')) {
              seatStage = stage;
              break;
            }
          } catch (_) {}
        }
        if (!seatStage) {
          seatStage = stages[stages.length - 1];
        }

        const scale = seatStage.scaleX() || 0.65;
        const stageX = seatStage.x() || 0;
        const stageY = seatStage.y() || 0;

        // Get canvas bounding rect
        let canvasEl = null;
        try {
          canvasEl = seatStage.container()?.querySelector('canvas');
        } catch (_) {}
        const canvasRect = canvasEl ? canvasEl.getBoundingClientRect() : null;

        // Walk all Rect nodes in the stage
        const layers = seatStage.getLayers();
        const availableSeats = [];
        const unavailableCount = { total: 0, ccc: 0 };

        for (const layer of layers) {
          const rects = layer.find('Rect');
          for (const rect of rects) {
            const attrs = rect.attrs;
            // Skip non-seat rects (e.g., viewport indicator, background)
            if (!attrs.width || attrs.width !== 18 || !attrs.height || attrs.height !== 18) continue;

            if (attrs.stroke === '#a67c00') {
              // Available seat (gold stroke = matches user's pool)
              const absPos = rect.getAbsolutePosition();
              availableSeats.push({
                konvaX: attrs.x,
                konvaY: attrs.y,
                absX: absPos.x,
                absY: absPos.y,
                fill: attrs.fill,
                selected: attrs.fill === '#a67c00',
                width: attrs.width,
                height: attrs.height,
              });
            } else {
              unavailableCount.total++;
              if (attrs.stroke === '#ccc') unavailableCount.ccc++;
            }
          }
        }

        // Also try to read Text nodes near seats to get row/seat labels
        const textNodes = [];
        for (const layer of layers) {
          const texts = layer.find('Text');
          for (const text of texts) {
            const attrs = text.attrs;
            if (attrs.className === 'seatRow' || (attrs.fontSize === 14 && attrs.fontFamily === 'rcbFontB')) {
              textNodes.push({ x: attrs.x, y: attrs.y, text: attrs.text });
            }
          }
        }

        return {
          canvasSeats: availableSeats,
          stageInfo: {
            scale,
            stageX,
            stageY,
            stageCount: stages.length,
            canvasRect: canvasRect ? {
              left: canvasRect.left,
              top: canvasRect.top,
              width: canvasRect.width,
              height: canvasRect.height
            } : null,
            unavailableCount,
            rowLabels: textNodes.slice(0, 10), // first 10 row labels for debugging
          },
          error: null
        };
      } catch (e) {
        return { error: e.message, canvasSeats: [], stageInfo: null };
      }
    });

    if (result.error) {
      logger.warn(`Canvas read error: ${result.error}`);
      return result;
    }

    // Convert canvas absolute positions to browser click coordinates
    const zoom = browserZoom || 1.0;
    const canvasRect = result.stageInfo?.canvasRect;

    if (canvasRect) {
      result.canvasSeats = result.canvasSeats.map(seat => {
        // absX/absY are already in canvas pixel space (includes stage scale + offset)
        const browserX = (canvasRect.left + seat.absX + 9) / zoom; // +9 = center of 18px rect
        const browserY = (canvasRect.top + seat.absY + 9) / zoom;
        return { ...seat, browserX, browserY };
      });
    }

    const unselected = result.canvasSeats.filter(s => !s.selected);
    logger.info(`[Canvas Read] ${result.canvasSeats.length} available seats on canvas (${unselected.length} unselected, ${result.canvasSeats.length - unselected.length} selected), ${result.stageInfo.unavailableCount.total} unavailable`);

    if (unselected.length > 0) {
      const samples = unselected.slice(0, 3).map(s =>
        `konva(${s.konvaX},${s.konvaY}) → browser(${s.browserX?.toFixed(1)},${s.browserY?.toFixed(1)})`
      ).join(' | ');
      logger.info(`[Canvas Read] Sample coords: ${samples}`);
    }

    return result;
  }

  /**
   * Find N consecutive available seats from canvas-read data.
   * Consecutive = same row (same konvaY) AND adjacent with exactly 25px spacing in konvaX.
   * This matches the website's layout algorithm where each seat advances x by 25,
   * and lm > 0 adds extra 25*lm gap (so non-adjacent seats have gaps > 25px).
   *
   * @param {Array} canvasSeats - Array from readSeatsFromCanvas().canvasSeats (unselected only)
   * @param {number} count - Number of consecutive seats needed
   * @returns {Array|null} Array of N consecutive seats with browserX/browserY, or null
   */
  findConsecutiveCanvasSeats(canvasSeats, count = 1) {
    if (!canvasSeats || canvasSeats.length === 0) return null;
    if (count === 0) return null;

    // Filter to unselected seats only
    const available = canvasSeats.filter(s => !s.selected);
    if (available.length < count) return null;

    // If only 1 seat needed, pick randomly
    if (count === 1) {
      const idx = Math.floor(Math.random() * available.length);
      const picked = [available[idx]];
      logger.info(`[Canvas Seats] Picked 1 random seat at konva(${picked[0].konvaX},${picked[0].konvaY})`);
      return picked;
    }

    // Group by konvaY (same row = same y position)
    const byRow = {};
    for (const seat of available) {
      const rowKey = String(seat.konvaY);
      if (!byRow[rowKey]) byRow[rowKey] = [];
      byRow[rowKey].push(seat);
    }

    // Find consecutive groups within each row
    const allGroups = [];
    const seatSpacing = 25; // Each seat advances x by 25 in the layout algorithm

    for (const rowKey of Object.keys(byRow)) {
      const rowSeats = byRow[rowKey].sort((a, b) => a.konvaX - b.konvaX);

      for (let i = 0; i <= rowSeats.length - count; i++) {
        let consecutive = true;
        for (let j = 1; j < count; j++) {
          const gap = rowSeats[i + j].konvaX - rowSeats[i + j - 1].konvaX;
          // Adjacent seats have exactly 25px gap. Seats with lm > 0 have larger gaps.
          // Allow small tolerance (±2px) for floating point.
          if (Math.abs(gap - seatSpacing) > 2) {
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
      logger.info(`[Canvas Seats] No ${count} consecutive seats found (${Object.keys(byRow).length} rows checked)`);
      return null;
    }

    // Pick randomly to avoid parallel browser conflicts
    const idx = Math.floor(Math.random() * allGroups.length);
    const picked = allGroups[idx];
    logger.info(`[Canvas Seats] Found ${allGroups.length} consecutive groups of ${count}, picked group ${idx + 1}: ` +
      `y=${picked[0].konvaY}, x=[${picked.map(s => s.konvaX).join(',')}]`);
    return picked;
  }
}

module.exports = KonvaSeatMapResolver;
