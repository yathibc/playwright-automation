const { chromium } = require('playwright');
const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');
const NetworkCapture = require('../utils/networkCapture');
const KonvaCanvasInterceptor = require('../utils/konvaCanvasInterceptor');
const fs = require('fs');
const path = require('path');

const logger = createModuleLogger('Browser');

class BrowserManager {
  constructor(sessionId = 1, account = null) {
    this.sessionId = sessionId;
    this.account = account || { id: `acc${sessionId}`, phone: config.website.loginPhone };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sessionPath = path.join(__dirname, '../../sessions', this.account.id);
    this.storageStateFile = path.join(this.sessionPath, 'user_session.json');
    this.sessionStorageFile = path.join(this.sessionPath, 'session_storage.json');
    this.networkCapture = null;
    this.konvaInterceptor = null;
    this._zoomApplied = false;
  }

  async initialize() {
    try {
      logger.info(`Initializing browser session ${this.sessionId}`);

      if (!fs.existsSync(this.sessionPath)) {
        fs.mkdirSync(this.sessionPath, { recursive: true });
      }

      this.browser = await chromium.launch({
        headless: config.browser.headless,
        slowMo: config.debug.slowMo,
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-dev-shm-usage',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });

      const contextOptions = {
        viewport: null,
        ignoreHTTPSErrors: true,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        permissions: ['geolocation'],
        geolocation: { longitude: 77.5946, latitude: 12.9716 }
      };

      if (fs.existsSync(this.storageStateFile)) {
        logger.info(`Loading saved storageState from ${this.storageStateFile}`);
        contextOptions.storageState = this.storageStateFile;
      }

      this.context = await this.browser.newContext(contextOptions);

      await this.restoreSessionStorageInitScript();
      await this.applyStealthScripts();

      this.page = await this.context.newPage();

      await this.setupEventListeners();

      logger.info(`Browser session ${this.sessionId} initialized successfully`);
      return true;
    } catch (error) {
      logger.error(`Failed to initialize browser session ${this.sessionId}: ${error.message}`);
      return false;
    }
  }

  // ── Zoom Control ────────────────────────────────────────────────────
  /**
   * Set page zoom using CSS zoom.
   *
   * This was more stable for this ticket flow than CDP page scaling. We keep it
   * simple and let coordinate conversion work from the actual zoomed canvas rect.
   */
  async applyZoom(level = null) {
    const zoom = level || config.browser.zoomLevel || 0.5;
    const pct = Math.round(zoom * 100);
    try {
      await this.page.evaluate((p) => {
        document.documentElement.style.zoom = p + '%';
        document.body.style.zoom = p + '%';
      }, pct);
      this._zoomApplied = true;
      logger.info(`Browser zoom set to ${pct}% via CSS zoom`);
    } catch (error) {
      logger.warn(`Failed to apply browser zoom: ${error.message}`);
    }
  }

  /**
   * Reset browser zoom back to 100%.
   */
  async resetZoom() {
    try {
      await this.page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        document.body.style.zoom = '100%';
      });
      this._zoomApplied = false;
      logger.info('Browser zoom reset to 100%');
    } catch (_) {}
  }

  /**
   * Get the current effective zoom level.
   */
  getZoomLevel() {
    return this._zoomApplied ? (config.browser.zoomLevel || 0.5) : 1.0;
  }

  // ── Auth Token Extraction ───────────────────────────────────────────
  /**
   * Extract the rtokn cookie value for API authentication.
   * @returns {string|null} The auth token or null
   */
  async extractAuthToken() {
    try {
      const cookies = await this.context.cookies();
      const rtoknCookie = cookies.find(c => c.name === 'rtokn');
      if (rtoknCookie) {
        logger.info('Extracted rtokn auth token from cookies');
        return rtoknCookie.value;
      }
      logger.warn('rtokn cookie not found');
      return null;
    } catch (error) {
      logger.error(`Failed to extract auth token: ${error.message}`);
      return null;
    }
  }

  // ── Session Management ──────────────────────────────────────────────

  async restoreSessionStorageInitScript() {
    try {
      if (!fs.existsSync(this.sessionStorageFile)) return;
      const payload = fs.readFileSync(this.sessionStorageFile, 'utf-8') || '{}';
      await this.context.addInitScript((storageJson) => {
        try {
          const data = JSON.parse(storageJson || '{}');
          Object.entries(data).forEach(([k, v]) => {
            if (v !== undefined && v !== null) sessionStorage.setItem(k, String(v));
          });
        } catch (e) {
          console.warn('sessionStorage restore failed', e);
        }
      }, payload);
      logger.info(`Loaded sessionStorage init script from ${this.sessionStorageFile}`);
    } catch (error) {
      logger.warn(`Unable to restore sessionStorage: ${error.message}`);
    }
  }

  async applyStealthScripts() {
    try {
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true
        });

        if (!window.chrome) {
          window.chrome = {};
        }
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            connect: () => {},
            sendMessage: () => {}
          };
        }

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true
        });

        delete window.__playwright;
        delete window.__pw_manual;
      });
      logger.info('Stealth anti-detection scripts applied');
    } catch (error) {
      logger.warn(`Failed to apply stealth scripts: ${error.message}`);
    }
  }

  async saveSession() {
    try {
      await this.context.storageState({ path: this.storageStateFile });
      await this.saveSessionStorage();
      logger.info('Saved storageState and sessionStorage');
    } catch (error) {
      logger.error(`Failed to save session: ${error.message}`);
    }
  }

  async saveSessionStorage() {
    try {
      if (!this.page || this.page.isClosed()) return;
      const payload = await this.page.evaluate(() => JSON.stringify(Object.fromEntries(
          Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]))));
      fs.writeFileSync(this.sessionStorageFile, payload || '{}', 'utf-8');
    } catch (error) {
      logger.warn(`Failed to save sessionStorage: ${error.message}`);
    }
  }

  async setupEventListeners() {
    this.page.on('console', (msg) => {
      if (config.debug.enabled) logger.debug(`Console ${msg.type()}: ${msg.text()}`);
    });
  }

  // ── Navigation (speed-optimized) ────────────────────────────────────

  async navigateToWebsite() {
    try {
      await this.page.goto(config.website.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.website.navigationTimeout
      });
      await this.waitForPageReady();
      return true;
    } catch (error) {
      logger.error(`Failed to navigate to website: ${error.message}`);
      return false;
    }
  }

  /**
   * Fast navigation — uses domcontentloaded, no unnecessary waits.
   */
  async navigateFast(url, timeout = null) {
    try {
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeout || config.website.navigationTimeout
      });
      return true;
    } catch (error) {
      logger.error(`Fast navigation to ${url} failed: ${error.message}`);
      return false;
    }
  }

  async waitForPageReady(timeout = 5000) {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout });
    } catch (_) {}

    try {
      await this.page.waitForFunction(
        () => document.readyState === 'interactive' || document.readyState === 'complete',
        { timeout: Math.min(timeout, 3000) }
      );
    } catch (_) {}

    return true;
  }

  // ── Element Interaction ─────────────────────────────────────────────

  async waitForElement(selector, options = {}) {
    try {
      return await this.page.waitForSelector(selector, {
        timeout: config.website.timeout,
        ...options
      });
    } catch (_) {
      return null;
    }
  }

  async firstVisible(selectors) {
    for (const selector of selectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible()) return el;
      } catch (_) {}
    }
    return null;
  }

  async waitForAnyVisible(selectors, timeout = 4000, interval = 200) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = await this.firstVisible(selectors);
      if (element) return element;
      await this.page.waitForTimeout(interval);
    }
    return null;
  }

  async clickElement(selector, options = {}) {
    try {
      await this.page.click(selector, { timeout: config.website.timeout, ...options });
      return true;
    } catch (_) {
      return false;
    }
  }

  async showClickMarker(x, y, label = 'Click') {
    if (!this.page) return;
    try {
      await this.page.evaluate(({ xPos, yPos, text }) => {
        const marker = document.createElement('div');
        marker.className = 'playwright-click-marker';
        marker.style.position = 'fixed';
        marker.style.left = `${xPos}px`;
        marker.style.top = `${yPos}px`;
        marker.style.width = '24px';
        marker.style.height = '24px';
        marker.style.marginLeft = '-12px';
        marker.style.marginTop = '-12px';
        marker.style.border = '3px solid #ff1744';
        marker.style.borderRadius = '50%';
        marker.style.background = 'rgba(255, 23, 68, 0.18)';
        marker.style.boxShadow = '0 0 0 9999px rgba(255, 23, 68, 0.05)';
        marker.style.zIndex = '2147483647';
        marker.style.pointerEvents = 'none';
        marker.style.transition = 'transform 0.15s ease-out, opacity 0.3s ease-out';

        const label = document.createElement('div');
        label.textContent = text;
        label.style.position = 'absolute';
        label.style.left = '16px';
        label.style.top = '-10px';
        label.style.background = '#ff1744';
        label.style.color = '#fff';
        label.style.padding = '2px 6px';
        label.style.borderRadius = '10px';
        label.style.fontSize = '12px';
        label.style.fontWeight = '700';
        label.style.whiteSpace = 'nowrap';
        label.style.fontFamily = 'Arial, sans-serif';
        marker.appendChild(label);

        document.body.appendChild(marker);

        requestAnimationFrame(() => {
          marker.style.transform = 'scale(1.2)';
        });

        setTimeout(() => {
          marker.style.opacity = '0';
          setTimeout(() => marker.remove(), 300);
        }, 900);
      }, { xPos: x, yPos: y, text: label });
    } catch (error) {
      logger.debug(`Unable to show click marker: ${error.message}`);
    }
  }

  async waitForNavigation() {
    try {
      await this.waitForPageReady(config.website.navigationTimeout);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Screenshot ──────────────────────────────────────────────────────

  async takeScreenshot(filename) {
    if (!config.debug.enabled) return;
    try {
      const screenshotPath = path.join(config.debug.screenshotPath, filename);
      if (!fs.existsSync(config.debug.screenshotPath)) fs.mkdirSync(config.debug.screenshotPath, { recursive: true });
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (_) {}
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  async close() {
    try {
      await this.stopKonvaInterceptor();
      await this.stopNetworkCapture();
      if (this.context) await this.saveSession();
      if (this.browser) await this.browser.close();
    } catch (error) {
      logger.error(`Error closing browser session ${this.sessionId}: ${error.message}`);
    }
  }

  // ── Network Capture ─────────────────────────────────────────────────

  async startNetworkCapture() {
    try {
      if (!config.networkCapture.enabled || !this.page || this.networkCapture) return;

      this.networkCapture = new NetworkCapture({
        sessionId: this.sessionId,
        accountId: this.account.id,
        logsRoot: path.join(__dirname, '../../logs'),
        captureBodies: config.networkCapture.captureBodies
      });

      await this.networkCapture.start(this.page);
      logger.info(`Network capture started for session ${this.sessionId}`);
    } catch (error) {
      logger.warn(`Unable to start network capture for session ${this.sessionId}: ${error.message}`);
    }
  }

  async stopNetworkCapture() {
    try {
      if (!this.networkCapture) return;
      await this.networkCapture.stop();
      logger.info(`Network capture stopped for session ${this.sessionId}`);
      this.networkCapture = null;
    } catch (error) {
      logger.warn(`Unable to stop network capture for session ${this.sessionId}: ${error.message}`);
    }
  }

  // ── Konva Canvas Interceptor ────────────────────────────────────────

  async startKonvaInterceptor() {
    try {
      if (!this.page || this.konvaInterceptor) return;

      this.konvaInterceptor = new KonvaCanvasInterceptor();

      await this.konvaInterceptor.start(this.page);
      logger.info(`Konva canvas interceptor started for session ${this.sessionId}`);
    } catch (error) {
      logger.warn(`Unable to start Konva interceptor for session ${this.sessionId}: ${error.message}`);
    }
  }

  async stopKonvaInterceptor() {
    try {
      if (!this.konvaInterceptor) return;
      await this.konvaInterceptor.stop();
      logger.info(`Konva canvas interceptor stopped for session ${this.sessionId}`);
      this.konvaInterceptor = null;
    } catch (error) {
      logger.warn(`Unable to stop Konva interceptor for session ${this.sessionId}: ${error.message}`);
    }
  }
}

module.exports = BrowserManager;