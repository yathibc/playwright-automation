const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');
const KonvaCanvasInterceptor = require('../utils/konvaCanvasInterceptor');
const KonvaSeatMapResolver = require('../utils/konvaSeatMapResolver');

const logger = createModuleLogger('SeatMapDetector');

class SeatMapDetector {
  constructor(browserManager) {
    this.browser = browserManager;
  }

  async detectAndInitializeSeatMap() {
    logger.info('Detecting seat map implementation...');

    await this.browser.takeScreenshot(`seatmap_detection_session${this.browser.sessionId}.png`);

    const seatMapType = await this.detectSeatMapType();

    if (!seatMapType) {
      logger.error('No seat map detected');
      return null;
    }

    logger.info(`Seat map type detected: ${seatMapType}`);

    switch (seatMapType) {
      case 'svg':
        return await this.initializeSVGSeatMap();
      case 'html':
        return await this.initializeHTMLSeatMap();
      case 'canvas':
        return await this.initializeCanvasSeatMap();
      default:
        logger.error(`Unsupported seat map type: ${seatMapType}`);
        return null;
    }
  }

  async detectSeatMapType() {
    try {
      const hasSVG = await this.browser.page.locator('svg').count() > 0;
      if (hasSVG) {
        const svgElements = await this.browser.page.locator('svg').all();
        for (const svg of svgElements) {
          const hasSeatElements = await svg.locator('circle, path, rect').count() > 0;
          if (hasSeatElements) {
            return 'svg';
          }
        }
      }

      const hasHTMLSeats = await this.browser.page.locator(
          '[data-seat], [data-row], .seat, [class*="seat"]').count() > 0;
      if (hasHTMLSeats) {
        return 'html';
      }

      const hasCanvas = await this.browser.page.locator('canvas').count() > 0;
      if (hasCanvas) {
        const canvasElements = await this.browser.page.locator('canvas').all();
        for (const canvas of canvasElements) {
          const isVisible = await canvas.isVisible();
          if (isVisible) {
            return 'canvas';
          }
        }
      }

      const seatMapSelectors = [
        '#seatmap',
        '.seatmap',
        '[id*="seat"]',
        '[class*="seat"]',
        '#seating-chart',
        '.seating-chart'
      ];

      for (const selector of seatMapSelectors) {
        const element = await this.browser.page.locator(selector).first();
        if (await element.isVisible()) {
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          if (tagName === 'svg') return 'svg';
          if (tagName === 'canvas') return 'canvas';
          return 'html';
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error detecting seat map type: ${error.message}`);
      return null;
    }
  }

  async initializeSVGSeatMap() {
    try {
      const svgSeats = await this.browser.page.locator('svg circle, svg path, svg rect').all();

      const seatData = [];
      for (const seat of svgSeats) {
        try {
          const seatInfo = await this.extractSVGSeatInfo(seat);
          if (seatInfo) {
            seatData.push(seatInfo);
          }
        } catch (error) {
          // Continue with next seat
        }
      }

      logger.info(`Found ${seatData.length} SVG seats`);
      return {
        type: 'svg',
        seats: seatData,
        selectSeat: this.selectSVGSeat.bind(this)
      };
    } catch (error) {
      logger.error(`Error initializing SVG seat map: ${error.message}`);
      return null;
    }
  }

  async extractSVGSeatInfo(seatElement) {
    try {
      const attributes = await seatElement.evaluate(el => {
        const attrs = {};
        for (let attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return attrs;
      });

      const seatInfo = {
        element: seatElement,
        attributes: attributes,
        available: false,
        row: null,
        number: null,
        stand: null
      };

      if (attributes['data-row']) seatInfo.row = attributes['data-row'];
      if (attributes['data-seat']) seatInfo.number = attributes['data-seat'];
      if (attributes['data-number']) seatInfo.number = attributes['data-number'];
      if (attributes['data-stand']) seatInfo.stand = attributes['data-stand'];
      if (attributes['data-section']) seatInfo.stand = attributes['data-section'];

      const classes = attributes['class'] || '';
      seatInfo.available = !classes.includes('unavailable') &&
                         !classes.includes('taken') &&
                         !classes.includes('sold') &&
                         !classes.includes('disabled');

      const fill = attributes['fill'] || '';
      if (fill.includes('grey') || fill.includes('gray') || fill.includes('#ccc')) {
        seatInfo.available = false;
      }

      return seatInfo;
    } catch (error) {
      return null;
    }
  }

  async initializeHTMLSeatMap() {
    try {
      const seatSelectors = [
        '[data-seat]',
        '[data-row]',
        '.seat',
        '[class*="seat"]',
        '[data-seat-number]',
        '.seat-item'
      ];

      let allSeats = [];
      for (const selector of seatSelectors) {
        const seats = await this.browser.page.locator(selector).all();
        allSeats = allSeats.concat(seats);
      }

      const seatData = [];
      for (const seat of allSeats) {
        try {
          const seatInfo = await this.extractHTMLSeatInfo(seat);
          if (seatInfo) {
            seatData.push(seatInfo);
          }
        } catch (error) {
          // Continue with next seat
        }
      }

      logger.info(`Found ${seatData.length} HTML seats`);
      return {
        type: 'html',
        seats: seatData,
        selectSeat: this.selectHTMLSeat.bind(this)
      };
    } catch (error) {
      logger.error(`Error initializing HTML seat map: ${error.message}`);
      return null;
    }
  }

  async extractHTMLSeatInfo(seatElement) {
    try {
      const elementData = await seatElement.evaluate(el => {
        const attrs = {};
        for (let attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return {
          attributes: attrs,
          textContent: el.textContent?.trim() || '',
          className: el.className || ''
        };
      });

      const seatInfo = {
        element: seatElement,
        available: false,
        row: null,
        number: null,
        stand: null
      };

      const { attributes, textContent, className } = elementData;

      if (attributes['data-row']) seatInfo.row = attributes['data-row'];
      if (attributes['data-seat']) seatInfo.number = attributes['data-seat'];
      if (attributes['data-number']) seatInfo.number = attributes['data-number'];
      if (attributes['data-stand']) seatInfo.stand = attributes['data-stand'];
      if (attributes['data-section']) seatInfo.stand = attributes['data-section'];

      if (textContent && !isNaN(textContent)) {
        seatInfo.number = textContent;
      }

      seatInfo.available = !className.includes('unavailable') &&
                         !className.includes('taken') &&
                         !className.includes('sold') &&
                         !className.includes('disabled') &&
                         !className.includes('occupied');

      return seatInfo;
    } catch (error) {
      return null;
    }
  }

  async initializeCanvasSeatMap() {
    try {
      const canvas = await this.browser.page.locator('canvas').first();

      const canvasInfo = await canvas.evaluate(el => {
        return {
          width: el.width,
          height: el.height,
          id: el.id
        };
      });

      logger.info(`Canvas seat map detected: ${canvasInfo.width}x${canvasInfo.height}`);

      // Check if we have intercepted Konva seat data from the network
      const interceptor = this.browser.konvaInterceptor;
      if (interceptor && interceptor.hasData()) {
        logger.info('Konva interceptor has seat data — resolving canvas seat coordinates');
        const data = interceptor.getData();
        const resolver = new KonvaSeatMapResolver({ pool: config.seats.pool || 'O' });

        // Pass the current CSS zoom level so coordinate conversion accounts for it.
        // The resolver will also auto-detect CSS zoom from the page, but we pass it
        // as a fallback. The resolver will use the Konva slider zoom (not CSS zoom)
        // to fit all seats in view.
        const cssZoom = this.browser.getZoomLevel ? this.browser.getZoomLevel() : 1.0;
        logger.info(`Resolving seats with CSS zoom=${cssZoom}, pool=${config.seats.pool || 'O'}`);

        const browserSeats = await resolver.resolveWithBrowserCoords(
          data.seatTemplate,
          data.seatList,
          this.browser.page,
          cssZoom
        );

        if (browserSeats.length > 0) {
          logger.info(`Konva resolver produced ${browserSeats.length} clickable seats for stand ${data.standCode}`);
          return {
            type: 'canvas',
            canvas: canvas,
            info: canvasInfo,
            seats: browserSeats,
            resolver: resolver,
            standCode: data.standCode,
            selectSeat: this.selectCanvasSeat.bind(this)
          };
        }
        logger.warn('Konva resolver found 0 available seats — falling back to basic canvas mode');
      } else {
        logger.info('No Konva interceptor data available — using basic canvas mode');
      }

      // Fallback: basic canvas mode without seat coordinate data
      return {
        type: 'canvas',
        canvas: canvas,
        info: canvasInfo,
        seats: [],
        selectSeat: this.selectCanvasSeat.bind(this)
      };
    } catch (error) {
      logger.error(`Error initializing canvas seat map: ${error.message}`);
      return null;
    }
  }

  /**
   * Re-resolve canvas seat coordinates (e.g., after switching stands or zooming).
   * Call this when the Konva stage state may have changed.
   */
  async refreshCanvasSeatCoords() {
    const interceptor = this.browser.konvaInterceptor;
    if (!interceptor || !interceptor.hasData()) {
      logger.warn('Cannot refresh canvas seats — no interceptor data');
      return null;
    }

    const data = interceptor.getData();
    const resolver = new KonvaSeatMapResolver({ pool: config.seats.pool || 'O' });
    const cssZoom = this.browser.getZoomLevel ? this.browser.getZoomLevel() : 1.0;
    const browserSeats = await resolver.resolveWithBrowserCoords(
      data.seatTemplate,
      data.seatList,
      this.browser.page,
      cssZoom
    );

    logger.info(`Refreshed ${browserSeats.length} canvas seat coordinates (cssZoom=${cssZoom})`);
    return {
      seats: browserSeats,
      resolver: resolver,
      standCode: data.standCode
    };
  }

  async selectSVGSeat(seatInfo) {
    try {
      await seatInfo.element.click();
      logger.info(`SVG seat clicked: ${seatInfo.row}${seatInfo.number}`);
      return true;
    } catch (error) {
      logger.error(`Error clicking SVG seat: ${error.message}`);
      return false;
    }
  }

  async selectHTMLSeat(seatInfo) {
    try {
      await seatInfo.element.click();
      logger.info(`HTML seat clicked: ${seatInfo.row}${seatInfo.number}`);
      return true;
    } catch (error) {
      logger.error(`Error clicking HTML seat: ${error.message}`);
      return false;
    }
  }

  async selectCanvasSeat(seatInfo) {
    try {
      const { x, y, row, number, konvaX, konvaY } = seatInfo;
      const label = row && number ? `${row}${number}` : 'unknown';
      logger.info(`Clicking canvas seat ${label}: browser(${x.toFixed(1)},${y.toFixed(1)})` +
        (konvaX !== undefined ? ` konva(${konvaX},${konvaY})` : ''));
      await this.browser.page.mouse.click(x, y);
      logger.info(`Canvas seat ${label} clicked successfully`);
      // Brief pause to let the UI register the click
      await this.browser.page.waitForTimeout(200);
      return true;
    } catch (error) {
      logger.error(`Error clicking canvas seat: ${error.message}`);
      return false;
    }
  }

  async waitForSeatMapLoad() {
    try {
      await this.browser.page.waitForLoadState('networkidle', {
        timeout: 30000
      });

      const seatMapLoaded = await this.browser.page.waitForSelector('svg, [data-seat], canvas', {
        timeout: 15000
      });

      if (seatMapLoaded) {
        await this.browser.takeScreenshot(`seatmap_loaded_session${this.browser.sessionId}.png`);
        logger.info('Seat map loaded successfully');
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`Error waiting for seat map: ${error.message}`);
      return false;
    }
  }

}

module.exports = SeatMapDetector;
