/**
 * KonvaCanvasInterceptor
 *
 * Intercepts seat-template and seat-list API responses from the browser's network traffic.
 * Uses Playwright's route interception to capture JSON payloads before they reach the app,
 * enabling us to calculate Konva canvas seat coordinates without DOM access.
 */
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('KonvaCanvasInterceptor');

class KonvaCanvasInterceptor {
  constructor() {
    this.seatTemplateData = null;   // Array from seat-template JSON
    this.seatListData = null;       // { result: [...] } from seat-list API
    this.standsListData = null;     // { result: { stands: [...] } } from standslist API
    this.interceptedStandCode = null;
    this.lastSeatDataAt = 0;
    this.page = null;
    this._routes = [];
  }

  /**
   * Start intercepting seat-related API responses on the given Playwright page.
   * Call this BEFORE navigating to the seat map page.
   */
  async start(page) {
    this.page = page;
    this.seatTemplateData = null;
    this.seatListData = null;
    this.standsListData = null;
    this.interceptedStandCode = null;
    this.lastSeatDataAt = 0;

    // Intercept seat-template JSON (hosted on S3)
    // URL pattern: https://tg3.s3.ap-south-1.amazonaws.com/revents/seat-template/{standCode}.json
    const seatTemplateRoute = async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.text();
        try {
          this.seatTemplateData = JSON.parse(body);
          // Extract stand code from URL
          const url = route.request().url();
          const match = url.match(/seat-template\/([^.]+)\.json/);
          if (match) {
            this.interceptedStandCode = match[1];
          }
          this.lastSeatDataAt = Date.now();
          logger.info(`Intercepted seat-template for stand ${this.interceptedStandCode}:
           ${(this.seatTemplateData || []).length} seats`);
        } catch (parseErr) {
          logger.warn(`Failed to parse seat-template response: ${parseErr.message}`);
        }
        await route.fulfill({
          response,
          body
        });
      } catch (err) {
        logger.warn(`Seat-template route handler error: ${err.message}`);
        await route.continue();
      }
    };

    // Intercept seat-list API
    // URL pattern: */ticket/seatlist/*
    const seatListRoute = async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.text();
        try {
          this.seatListData = JSON.parse(body);
          this.lastSeatDataAt = Date.now();
          const resultCount = this.seatListData?.result?.length || 0;
          logger.info(`Intercepted seat-list: ${resultCount} seat entries`);
        } catch (parseErr) {
          logger.warn(`Failed to parse seat-list response: ${parseErr.message}`);
        }
        await route.fulfill({
          response,
          body
        });
      } catch (err) {
        logger.warn(`Seat-list route handler error: ${err.message}`);
        await route.continue();
      }
    };

    // Intercept stands-list API to know available stands
    // URL pattern: */ticket/standslist/*
    const standsListRoute = async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.text();
        try {
          this.standsListData = JSON.parse(body);
          logger.info(`Intercepted stands-list`);
        } catch (parseErr) {
          logger.warn(`Failed to parse stands-list response: ${parseErr.message}`);
        }
        await route.fulfill({
          response,
          body
        });
      } catch (err) {
        logger.warn(`Stands-list route handler error: ${err.message}`);
        await route.continue();
      }
    };

    await page.route('**/revents/seat-template/*.json', seatTemplateRoute);
    await page.route('**/ticket/seatlist/**', seatListRoute);
    await page.route('**/ticket/standslist/**', standsListRoute);

    this._routes = [
      { pattern: '**/revents/seat-template/*.json', handler: seatTemplateRoute },
      { pattern: '**/ticket/seatlist/**', handler: seatListRoute },
      { pattern: '**/ticket/standslist/**', handler: standsListRoute }
    ];

    logger.info('Konva canvas API interception started');
  }

  /**
   * Stop intercepting and clean up routes.
   */
  async stop() {
    if (!this.page) return;
    for (const r of this._routes) {
      try {
        await this.page.unroute(r.pattern, r.handler);
      } catch (_) {}
    }
    this._routes = [];
    logger.info('Konva canvas API interception stopped');
  }

  /**
   * Wait until both seat-template and seat-list data have been intercepted.
   * @param {number} timeoutMs - max wait time in ms (default 30s)
   * @returns {boolean} true if both were captured
   */
  async waitForSeatData(timeoutMs = 30000, minCapturedAt = 0) {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      if (this.seatTemplateData && this.seatListData && this.lastSeatDataAt >= minCapturedAt) {
        logger.info('Both seat-template and seat-list data captured');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    logger.warn(`Timed out waiting for seat data. Template: ${!!this.seatTemplateData}, List: ${!!this.seatListData}`);
    return false;
  }

  /**
   * Check if we have the data needed to calculate coordinates.
   */
  hasData() {
    return !!(this.seatTemplateData && this.seatListData);
  }

  /**
   * Get the raw intercepted data.
   */
  getData() {
    return {
      seatTemplate: this.seatTemplateData,
      seatList: this.seatListData,
      standCode: this.interceptedStandCode,
      standsList: this.standsListData
    };
  }

  /**
   * Reset captured data (e.g., when switching stands).
   */
  reset() {
    this.seatTemplateData = null;
    this.seatListData = null;
    this.interceptedStandCode = null;
    this.lastSeatDataAt = 0;
  }
}

module.exports = KonvaCanvasInterceptor;