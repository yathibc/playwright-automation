const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

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

      const hasHTMLSeats = await this.browser.page.locator('[data-seat], [data-row], .seat, [class*="seat"]').count() > 0;
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
      
      return {
        type: 'canvas',
        canvas: canvas,
        info: canvasInfo,
        selectSeat: this.selectCanvasSeat.bind(this)
      };
    } catch (error) {
      logger.error(`Error initializing canvas seat map: ${error.message}`);
      return null;
    }
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
      const { x, y } = seatInfo;
      await this.browser.page.mouse.click(x, y);
      logger.info(`Canvas seat clicked at: (${x}, ${y})`);
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

  async findPreferredStand() {
    const preferredStand = config.seats.preferredStand;
    
    const standSelectors = [
      `[data-section="${preferredStand}"]`,
      `[data-stand="${preferredStand}"]`,
      `[aria-label*="${preferredStand}"]`,
      `[title*="${preferredStand}"]`,
      `.${preferredStand.toLowerCase().replace(' ', '-')}`,
      `#${preferredStand.toLowerCase().replace(' ', '-')}`
    ];

    for (const selector of standSelectors) {
      try {
        const standElement = await this.browser.page.locator(selector).first();
        if (await standElement.isVisible()) {
          logger.info(`Found preferred stand: ${preferredStand}`);
          return standElement;
        }
      } catch (error) {
        // Continue to next selector
      }
    }

    logger.warn(`Preferred stand "${preferredStand}" not found`);
    return null;
  }
}

module.exports = SeatMapDetector;
