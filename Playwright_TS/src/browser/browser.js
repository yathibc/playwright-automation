const { chromium } = require('playwright');
const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');
const NetworkCapture = require('../utils/networkCapture');
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
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
        // Hide navigator.webdriver (safe — does not affect reCAPTCHA)
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true
        });

        // Emulate chrome runtime object (present in real Chrome, absent in automation)
        if (!window.chrome) {
          window.chrome = {};
        }
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            connect: () => { },
            sendMessage: () => { }
          };
        }

        // Emulate realistic languages (safe — does not affect reCAPTCHA)
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true
        });

        // Hide Playwright-specific properties
        delete window.playwright;
        delete window.__pw_manual;

        // NOTE: navigator.plugins override and navigator.permissions.query patch
        // were removed because they break Google reCAPTCHA v3 validation.
        // reCAPTCHA checks plugin consistency and permissions API integrity.
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
      const payload = await this.page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]))));
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

  async waitForPageReady(timeout = Math.min(5000, config.website.navigationTimeout)) {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout });
    } catch (_) { }

    try {
      await this.page.waitForFunction(
        () => document.readyState === 'interactive' || document.readyState === 'complete',
        { timeout }
      );
    } catch (_) { }

    try {
      await this.page.waitForTimeout(250);
    } catch (_) { }

    return true;
  }

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
      } catch (_) { }
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

  async waitForNavigation() {
    try {
      await this.waitForPageReady(config.website.navigationTimeout);
      return true;
    } catch (_) {
      return false;
    }
  }

  async takeScreenshot(filename) {
    if (!config.debug.enabled) return;
    try {
      const screenshotPath = path.join(config.debug.screenshotPath, filename);
      if (!fs.existsSync(config.debug.screenshotPath)) fs.mkdirSync(config.debug.screenshotPath, { recursive: true });
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (_) { }
  }

  async close() {
    try {
      await this.stopNetworkCapture();
      if (this.context) await this.saveSession();
      if (this.browser) await this.browser.close();
    } catch (error) {
      logger.error(`Error closing browser session ${this.sessionId}: ${error.message}`);
    }
  }

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
      logger.info(`Network capture started for session ${this.sessionId}; files will be written under logs/network and logs/har`);
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
}

module.exports = BrowserManager;
