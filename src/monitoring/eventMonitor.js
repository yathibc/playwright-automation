const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('EventMonitor');

class EventMonitor {
  constructor(browserManager, matchDetector, seatMapDetector, seatSelector, checkoutFlow) {
    this.browser = browserManager;
    this.matchDetector = matchDetector;
    this.seatMapDetector = seatMapDetector;
    this.seatSelector = seatSelector;
    this.checkoutFlow = checkoutFlow;
    this.isMonitoring = false;
    this.observer = null;
    this.availabilityInterval = null;
    this.bookingSucceeded = false;
  }

  async startEventDrivenMonitoring() {
    logger.info('Starting event-driven monitoring...');
    this.isMonitoring = true;
    this.bookingSucceeded = false;

    await this.setupMutationObserver();
    await this.setupNetworkMonitoring();
    await this.setupAvailabilityMonitoring();
  }

  async setupMutationObserver() {
    try {
      await this.browser.page.evaluate(() => {
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
              mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) {
                  const hasBookingElements = node.textContent &&
                    (node.textContent.includes('Book') ||
                     node.textContent.includes('Ticket') ||
                     node.textContent.includes('Select'));

                  if (hasBookingElements) {
                    window.bookingMutationDetected = true;
                  }
                }
              });
            }
          });
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true
        });

        return observer;
      });

      logger.info('MutationObserver setup completed');
    } catch (error) {
      logger.error(`Error setting up MutationObserver: ${error.message}`);
    }
  }

  async setupNetworkMonitoring() {
    try {
      this.browser.page.on('response', async (response) => {
        const url = response.url();

        if (url.includes('/availability') ||
            url.includes('/inventory') ||
            url.includes('/seatmap') ||
            url.includes('/events')) {

          logger.info(`API Response: ${response.status()} ${url}`);

          try {
            const data = await response.text();
            if (data.includes('available') || data.includes('seats')) {
              await this.handleAvailabilityChange(url, data);
            }
          } catch (error) {
            // Response might not be JSON or text
          }
        }
      });

      logger.info('Network monitoring setup completed');
    } catch (error) {
      logger.error(`Error setting up network monitoring: ${error.message}`);
    }
  }

  async setupAvailabilityMonitoring() {
    try {
      if (this.availabilityInterval) {
        clearInterval(this.availabilityInterval);
      }

      this.availabilityInterval = setInterval(async () => {
        if (!this.isMonitoring) return;

        const hasNewContent = await this.checkForNewContent();
        if (hasNewContent) {
          logger.info('New content detected, triggering booking attempt');
          await this.triggerBookingAttempt();
        }
      }, 5000);

      logger.info('Availability monitoring setup completed');
    } catch (error) {
      logger.error(`Error setting up availability monitoring: ${error.message}`);
    }
  }

  async checkForNewContent() {
    try {
      const page = this.browser.page;

      // Check booking-related buttons individually (Playwright :has-text in comma-separated CSS is unreliable)
      const bookingSelectors = [
        'button:has-text("Book")',
        'button:has-text("Ticket")',
        '.book-now',
        'button:has-text("Buy")',
        'button:has-text("Select Seats")'
      ];
      for (const sel of bookingSelectors) {
        try {
          if (await page.locator(sel).count() > 0) return true;
        } catch (_) {}
      }

      // Check for seat map indicators
      const seatMapSelectors = ['svg', '[data-seat]', 'canvas', '[class*="seat-map"]', '[class*="seatmap"]'];
      for (const sel of seatMapSelectors) {
        try {
          if (await page.locator(sel).count() > 0) return true;
        } catch (_) {}
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  async handleAvailabilityChange(url, data) {
    logger.info(`Availability change detected from: ${url}`);

    try {
      if (data.includes('RCB') && data.includes('SRH')) {
        logger.info('Match availability detected');
        await this.triggerBookingAttempt();
      }
    } catch (error) {
      logger.error(`Error handling availability change: ${error.message}`);
    }
  }

  async triggerBookingAttempt() {
    if (!this.isMonitoring) return;

    try {
      logger.info('Triggering booking attempt...');

      const matchFound = await this.matchDetector.searchForMatch();
      if (matchFound) {
        await this.processSeatSelection();
      }
    } catch (error) {
      logger.error(`Error in booking attempt: ${error.message}`);
    }
  }

  async processSeatSelection() {
    try {
      logger.info('Processing seat selection...');

      const seatMapLoaded = await this.seatMapDetector.waitForSeatMapLoad();
      if (!seatMapLoaded) {
        logger.error('Seat map failed to load');
        return false;
      }

      const seatMap = await this.seatMapDetector.detectAndInitializeSeatMap();
      if (!seatMap) {
        logger.error('Could not initialize seat map');
        return false;
      }

      const selectionResult = await this.seatSelector.selectConsecutiveSeats(seatMap);

      if (selectionResult) {
        logger.info(`Seats selected successfully via ${selectionResult.strategy}`);
        this.isMonitoring = false;
        this.bookingSucceeded = await this.checkoutFlow.runFromCurrentPage();
        return this.bookingSucceeded;
      }

      return false;
    } catch (error) {
      logger.error(`Error processing seat selection: ${error.message}`);
      return false;
    }
  }

  async monitorForDuration(durationMs) {
    logger.info(`Monitoring for ${durationMs}ms...`);

    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        if (!this.isMonitoring || Date.now() - startTime > durationMs) {
          clearInterval(checkInterval);
          resolve(this.isMonitoring);
          return;
        }

        await this.checkForNewContent();
      }, 2000);
    });
  }

  stop() {
    logger.info('Stopping event monitoring...');
    this.isMonitoring = false;

    if (this.availabilityInterval) {
      clearInterval(this.availabilityInterval);
      this.availabilityInterval = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  hasBookingSucceeded() {
    return this.bookingSucceeded;
  }

  async waitForSpecificEvent(eventType, timeoutMs = 30000) {
    logger.info(`Waiting for specific event: ${eventType}`);

    return new Promise((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, timeoutMs);

      const checkEvent = async () => {
        if (resolved) return;

        try {
          switch (eventType) {
            case 'match_available':
              const matchFound = await this.matchDetector.searchForMatch();
              if (matchFound) {
                resolved = true;
                clearTimeout(timeout);
                resolve(true);
              }
              break;

            case 'seatmap_loaded':
              const seatMap = await this.seatMapDetector.detectAndInitializeSeatMap();
              if (seatMap) {
                resolved = true;
                clearTimeout(timeout);
                resolve(true);
              }
              break;

            case 'seats_available':
              const hasSeats = await this.checkForNewContent();
              if (hasSeats) {
                resolved = true;
                clearTimeout(timeout);
                resolve(true);
              }
              break;
          }
        } catch (error) {
          // Continue checking
        }

        if (!resolved) {
          setTimeout(checkEvent, 1000);
        }
      };

      checkEvent();
    });
  }

  async setupDOMChangeDetection() {
    try {
      await this.browser.page.evaluate(() => {
        let lastContentHash = document.body.innerHTML.length;

        const checkContent = () => {
          const currentHash = document.body.innerHTML.length;
          if (currentHash !== lastContentHash) {
            lastContentHash = currentHash;
            window.contentChanged = true;
          }
        };

        setInterval(checkContent, 1000);
        return true;
      });

      logger.info('DOM change detection setup completed');
    } catch (error) {
      logger.error(`Error setting up DOM change detection: ${error.message}`);
    }
  }
}

module.exports = EventMonitor;