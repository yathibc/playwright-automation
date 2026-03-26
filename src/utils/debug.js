const { createModuleLogger } = require('./logger');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');

const logger = createModuleLogger('Debug');

class DebugManager {
  constructor(browserManager) {
    this.browser = browserManager;
    this.isEnabled = config.debug.enabled;
    this.screenshotPath = config.debug.screenshotPath;
    this.overlays = [];
  }

  async takeScreenshot(filename, options = {}) {
    if (!this.isEnabled) return;

    try {
      if (!fs.existsSync(this.screenshotPath)) {
        fs.mkdirSync(this.screenshotPath, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fullFilename = `${timestamp}_${filename}`;
      const screenshotPath = path.join(this.screenshotPath, fullFilename);

      await this.browser.page.screenshot({
        path: screenshotPath,
        fullPage: true,
        ...options
      });

      logger.info(`Screenshot saved: ${fullFilename}`);
      return screenshotPath;
    } catch (error) {
      logger.error(`Failed to take screenshot: ${error.message}`);
      return null;
    }
  }

  async highlightElement(selector, color = 'red') {
    if (!this.isEnabled) return;

    try {
      await this.browser.page.evaluate((sel, col) => {
        const element = document.querySelector(sel);
        if (element) {
          element.style.border = `3px solid ${col}`;
          element.style.backgroundColor = `${col}33`;
          return true;
        }
        return false;
      }, selector, color);

      this.overlays.push(selector);
      logger.debug(`Highlighted element: ${selector}`);
    } catch (error) {
      logger.error(`Failed to highlight element: ${error.message}`);
    }
  }

  async highlightSeats(seatElements) {
    if (!this.isEnabled || !seatElements.length) return;

    try {
      await this.browser.page.evaluate((seats) => {
        seats.forEach((seat, index) => {
          if (seat.element) {
            seat.element.style.border = '2px solid blue';
            seat.element.style.backgroundColor = '#0066ff33';

            if (seat.row && seat.number) {
              const label = document.createElement('div');
              label.textContent = `${seat.row}${seat.number}`;
              label.style.position = 'absolute';
              label.style.background = 'yellow';
              label.style.border = '1px solid black';
              label.style.padding = '2px';
              label.style.fontSize = '12px';
              label.style.zIndex = '9999';

              const rect = seat.element.getBoundingClientRect();
              label.style.left = `${rect.left + rect.width / 2}px`;
              label.style.top = `${rect.top - 20}px`;

              document.body.appendChild(label);
            }
          }
        });
      }, seatElements);

      logger.info(`Highlighted ${seatElements.length} seats`);
    } catch (error) {
      logger.error(`Failed to highlight seats: ${error.message}`);
    }
  }

  async addSeatOverlay(seatInfo) {
    if (!this.isEnabled) return;

    try {
      await this.browser.page.evaluate((seat) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.border = '2px solid green';
        overlay.style.backgroundColor = '#00ff0033';
        overlay.style.zIndex = '9998';
        overlay.style.pointerEvents = 'none';

        if (seat.element && seat.element.getBoundingClientRect) {
          const rect = seat.element.getBoundingClientRect();
          overlay.style.left = `${rect.left}px`;
          overlay.style.top = `${rect.top}px`;
          overlay.style.width = `${rect.width}px`;
          overlay.style.height = `${rect.height}px`;

          const label = document.createElement('div');
          label.textContent = `${seat.row || '?'}${seat.number || '?'}`;
          label.style.background = 'green';
          label.style.color = 'white';
          label.style.padding = '2px 4px';
          label.style.fontSize = '10px';
          label.style.position = 'absolute';
          label.style.top = '-20px';
          label.style.left = '0';

          overlay.appendChild(label);
          document.body.appendChild(overlay);
        }
      }, seatInfo);

      logger.debug(`Added overlay for seat: ${seatInfo.row}${seatInfo.number}`);
    } catch (error) {
      logger.error(`Failed to add seat overlay: ${error.message}`);
    }
  }

  async clearOverlays() {
    if (!this.isEnabled) return;

    try {
      await this.browser.page.evaluate(() => {
        const overlays = document.querySelectorAll('[style*="z-index: 999"]');
        overlays.forEach(overlay => overlay.remove());

        const highlighted = document.querySelectorAll('[style*="border"]');
        highlighted.forEach(element => {
          element.style.border = '';
          element.style.backgroundColor = '';
        });
      });

      this.overlays = [];
      logger.debug('Cleared all overlays');
    } catch (error) {
      logger.error(`Failed to clear overlays: ${error.message}`);
    }
  }

  async logPageStructure() {
    if (!this.isEnabled) return;

    try {
      const structure = await this.browser.page.evaluate(() => {
        const getInfo = (element, depth = 0) => {
          const indent = '  '.repeat(depth);
          const tagName = element.tagName.toLowerCase();
          const id = element.id ? `#${element.id}` : '';
          const classes = element.className ? `.${element.className.split(' ').join('.')}` : '';
          const text = element.textContent ? element.textContent.substring(0, 50).trim() : '';

          let result = `${indent}${tagName}${id}${classes}`;
          if (text) result += ` - "${text}"`;

          const children = Array.from(element.children);
          if (children.length > 0 && depth < 3) {
            result += '\n' + children.map(child => getInfo(child, depth + 1)).join('\n');
          }

          return result;
        };

        return getInfo(document.body);
      });

      const logFile = path.join(this.screenshotPath, `page_structure_${Date.now()}.txt`);
      fs.writeFileSync(logFile, structure);
      logger.info(`Page structure logged to: ${logFile}`);
    } catch (error) {
      logger.error(`Failed to log page structure: ${error.message}`);
    }
  }

  async logElementAttributes(selector) {
    if (!this.isEnabled) return;

    try {
      const attributes = await this.browser.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (!element) return null;

        const attrs = {};
        for (let attr of element.attributes) {
          attrs[attr.name] = attr.value;
        }

        return {
          tagName: element.tagName,
          innerText: element.innerText?.substring(0, 200),
          attributes: attrs
        };
      }, selector);

      if (attributes) {
        logger.debug(`Element attributes for ${selector}:`, attributes);

        const logFile = path.join(this.screenshotPath,
            `element_${selector.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.json`);
        fs.writeFileSync(logFile, JSON.stringify(attributes, null, 2));
        logger.info(`Element attributes logged to: ${logFile}`);
      }
    } catch (error) {
      logger.error(`Failed to log element attributes: ${error.message}`);
    }
  }

  async simulateSlowTyping(text, selector) {
    if (!this.isEnabled) {
      await this.browser.page.fill(selector, text);
      return;
    }

    try {
      await this.browser.page.focus(selector);
      for (const char of text) {
        await this.browser.page.keyboard.type(char);
        await this.browser.page.waitForTimeout(100);
      }
      logger.debug(`Slow typing completed for: ${text}`);
    } catch (error) {
      logger.error(`Failed to simulate slow typing: ${error.message}`);
    }
  }

  async createDebugPanel() {
    if (!this.isEnabled) return;

    try {
      await this.browser.page.evaluate(() => {
        const panel = document.createElement('div');
        panel.id = 'debug-panel';
        panel.style.position = 'fixed';
        panel.style.top = '10px';
        panel.style.right = '10px';
        panel.style.width = '300px';
        panel.style.background = 'rgba(0, 0, 0, 0.8)';
        panel.style.color = 'white';
        panel.style.padding = '10px';
        panel.style.borderRadius = '5px';
        panel.style.zIndex = '10000';
        panel.style.fontSize = '12px';
        panel.style.fontFamily = 'monospace';

        panel.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 10px;">Debug Panel</div>
          <div id="debug-info">Initializing...</div>
          <button onclick="document.getElementById('debug-panel').style.display='none'"
                  style="margin-top: 10px; padding: 5px;">Close</button>
        `;

        document.body.appendChild(panel);

        window.updateDebugInfo = (info) => {
          const infoDiv = document.getElementById('debug-info');
          if (infoDiv) {
            infoDiv.innerHTML = info;
          }
        };
      });

      logger.info('Debug panel created');
    } catch (error) {
      logger.error(`Failed to create debug panel: ${error.message}`);
    }
  }

  async updateDebugInfo(info) {
    if (!this.isEnabled) return;

    try {
      await this.browser.page.evaluate((debugInfo) => {
        if (window.updateDebugInfo) {
          window.updateDebugInfo(debugInfo);
        }
      }, info);
    } catch (error) {
      logger.error(`Failed to update debug info: ${error.message}`);
    }
  }

  async recordVideo(filename) {
    if (!this.isEnabled) return null;

    try {
      const videoPath = path.join(this.screenshotPath, filename);

      const context = this.browser.context;
      const video = await context.newPage({
        recordVideo: {
          dir: this.screenshotPath,
          size: { width: 1920, height: 1080 }
        }
      });

      logger.info(`Video recording started: ${filename}`);
      return { page: video, path: videoPath };
    } catch (error) {
      logger.error(`Failed to start video recording: ${error.message}`);
      return null;
    }
  }

  async logNetworkRequests() {
    if (!this.isEnabled) return;

    try {
      const requests = [];

      this.browser.page.on('request', request => {
        requests.push({
          url: request.url(),
          method: request.method(),
          timestamp: new Date().toISOString()
        });
      });

      this.browser.page.on('response', response => {
        requests.push({
          url: response.url(),
          status: response.status(),
          timestamp: new Date().toISOString()
        });
      });

      // Log requests every 30 seconds
      setInterval(() => {
        if (requests.length > 0) {
          const logFile = path.join(this.screenshotPath, `network_${Date.now()}.json`);
          fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
          requests.length = 0; // Clear the array
        }
      }, 30000);

      logger.info('Network request logging enabled');
    } catch (error) {
      logger.error(`Failed to setup network logging: ${error.message}`);
    }
  }

  async performanceMetrics() {
    if (!this.isEnabled) return;

    try {
      const metrics = await this.browser.page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        return {
          domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
          loadComplete: navigation.loadEventEnd - navigation.loadEventStart,
          firstPaint: performance.getEntriesByType('paint')[0]?.startTime,
          firstContentfulPaint: performance.getEntriesByType('paint')[1]?.startTime
        };
      });

      logger.info('Performance metrics:', metrics);

      const metricsFile = path.join(this.screenshotPath, `performance_${Date.now()}.json`);
      fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
    } catch (error) {
      logger.error(`Failed to collect performance metrics: ${error.message}`);
    }
  }
}

module.exports = DebugManager;