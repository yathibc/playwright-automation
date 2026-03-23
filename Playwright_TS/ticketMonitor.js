require('dotenv').config();

// Standalone Logger
const logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
  warn: (msg) => console.log(`[${new Date().toISOString()}] WARN: ${msg}`),
  error: (msg) => console.log(`[${new Date().toISOString()}] ERROR: ${msg}`),
  debug: (msg) => console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`)
};

// Standalone Config
const config = {
  website: {
    url: process.env.TICKET_URL || 'https://shop.royalchallengers.com',
    loginPhone: process.env.LOGIN_PHONE || '7899179393',
    timeout: 30000,
    navigationTimeout: 60000,
    otpWaitMinutes: parseInt(process.env.OTP_WAIT_MINUTES) || 5
  },
  runtime: {
    timeoutMinutes: parseInt(process.env.TIMEOUT_MINUTES) || 120
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }
};

// Standalone Telegram Notifier
class TelegramNotifier {
  constructor() {
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
  }

  async sendMessage(message) {
    if (!this.botToken || !this.chatId) {
      logger.warn('Telegram credentials not configured');
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'Markdown'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      logger.info('Telegram message sent successfully');
      return data;
    } catch (error) {
      logger.error(`Failed to send Telegram message: ${error.message}`);
      throw error;
    }
  }

  async sendError(error, context = 'System') {
    const message = `❌ *Error in ${context}*\n\n${error}`;
    await this.sendMessage(message);
  }
}

// Standalone Browser Manager
class BrowserManager {
  constructor(sessionId = 1, account = null) {
    this.sessionId = sessionId;
    this.account = account || { id: `acc${sessionId}`, phone: config.website.loginPhone };
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async initialize() {
    try {
      logger.info(`Initializing browser session ${this.sessionId}`);

      const { chromium } = require('playwright');
      
      this.browser = await chromium.launch({
        headless: process.env.HEADLESS === 'true',
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });

      const contextOptions = {
        viewport: null,
        ignoreHTTPSErrors: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      this.context = await this.browser.newContext(contextOptions);
      await this.applyStealthScripts();
      this.page = await this.context.newPage();

      logger.info(`Browser session ${this.sessionId} initialized successfully`);
      return true;
    } catch (error) {
      logger.error(`Failed to initialize browser session ${this.sessionId}: ${error.message}`);
      return false;
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

        delete window.playwright;
        delete window.__pw_manual;
      });
      logger.info('Stealth anti-detection scripts applied');
    } catch (error) {
      logger.warn(`Failed to apply stealth scripts: ${error.message}`);
    }
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

  async waitForPageReady(timeout = 5000) {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout });
    } catch (_) {}

    try {
      await this.page.waitForFunction(
        () => document.readyState === 'interactive' || document.readyState === 'complete',
        { timeout }
      );
    } catch (_) {}

    try {
      await this.page.waitForTimeout(250);
    } catch (_) {}

    return true;
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

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch (error) {
      logger.error(`Error closing browser session ${this.sessionId}: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Standalone Login Manager
class LoginManager {
  constructor(browserManager, telegramNotifier) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
  }

  async detectPassiveAuthState() {
    try {
      const currentUrl = this.browser.page.url().toLowerCase();

      if (currentUrl.includes('/auth?callbackurl=')) {
        return 'phone_required';
      }

      if (currentUrl.includes('/rcbian/mypage') || currentUrl.endsWith('/rcbian') || currentUrl.includes('/rcbian?')) {
        const myAccountHeading = await this.browser.firstVisible([
          'text=My Account',
          '[role="heading"]:has-text("My Account")',
          'button:has-text("My Orders")',
          'button:has-text("Profile")',
          'button:has-text("My Addresses")'
        ]);
        if (myAccountHeading) {
          return 'logged_in';
        }
      }

      const phoneInput = await this.browser.firstVisible([
        "input[type='tel']:not([data-index])",
        "input[placeholder*='phone' i]",
        "input[placeholder*='mobile' i]",
        "input[name*='phone' i]"
      ]);

      if (phoneInput) {
        return 'phone_required';
      }

      const otpIndicators = await this.browser.firstVisible([
        "button:has-text('Validate')",
        "button:has-text('Verify')",
        "text=/Enter OTP/i",
        "input[data-index]",
        "input[autocomplete='one-time-code']"
      ]);

      if (otpIndicators) {
        return 'otp_required';
      }

      return 'unknown';
    } catch (error) {
      logger.warn(`Auth state detection failed: ${error.message}`);
      return 'unknown';
    }
  }

  async isLoggedIn() {
    try {
      let state = await this.detectPassiveAuthState();
      if (state === 'phone_required' || state === 'otp_required') {
        return false;
      }

      if (state === 'logged_in') {
        return true;
      }

      return false;
    } catch (error) {
      logger.warn(`Login check failed: ${error.message}`);
      return false;
    }
  }

  async fillPhoneAndNext() {
    const phoneInput = await this.browser.firstVisible([
      "input[type='tel']:not([data-index])",
      "input[placeholder*='phone' i]",
      "input[placeholder*='mobile' i]",
      "input[name*='phone' i]"
    ]);

    if (!phoneInput) return false;

    await phoneInput.fill(this.browser.account.phone);

    const nextBtn = await this.browser.firstVisible([
      "button:has-text('Next')",
      "button:has-text('Continue')",
      "button:has-text('Send OTP')",
      "button[type='submit']"
    ]);

    if (nextBtn) {
      await nextBtn.click();
      return true;
    }

    return false;
  }

  async waitForManualOtpSuccess() {
    const timeoutMs = config.website.otpWaitMinutes * 60 * 1000;
    const start = Date.now();
    let iteration = 0;

    await this.telegram.sendMessage(`🔐 Manual OTP required for ${this.browser.account.id}. Complete login within ${config.website.otpWaitMinutes} minutes.`);

    while (Date.now() - start < timeoutMs) {
      iteration += 1;

      const state = await this.detectPassiveAuthState();
      if (state === 'logged_in' || (iteration % 3 === 0 && await this.isLoggedIn())) {
        await this.telegram.sendMessage('✅ Login successful.');
        return true;
      }
      await this.browser.page.waitForTimeout(500);
    }

    return false;
  }

  async probeAuthenticatedMenu() {
    try {
      const optionsButton = await this.browser.firstVisible([
        "button[aria-label='Options']",
        "[aria-label*='profile' i]",
        "button:has-text('Profile')",
        "button:has-text('Account')",
        'header button:last-child',
        '.navbar button:last-child'
      ]);

      if (!optionsButton) {
        return false;
      }

      const existingMenu = await this.browser.firstVisible([
        '[role="menu"]',
        '[role="menuitem"]:has-text("My Account")',
        '[role="menuitem"]:has-text("Orders")',
        '[role="menuitem"]:has-text("Logout")'
      ]);

      if (!existingMenu) {
        await optionsButton.click();
        await this.browser.sleep(500);
      }

      const authenticatedMenuItem = await this.browser.firstVisible([
        '[role="menuitem"]:has-text("My Account")',
        '[role="menuitem"]:has-text("Orders")',
        '[role="menuitem"]:has-text("Profile")',
        '[role="menuitem"]:has-text("Logout")'
      ]);

      return !!authenticatedMenuItem;
    } catch (error) {
      logger.debug(`Authenticated menu probe failed: ${error.message}`);
      return false;
    }
  }

  async ensureOptionsMenuOpen() {
    const existingMenu = await this.browser.firstVisible([
      '[role="menu"]',
      '[role="menuitem"]:has-text("My Account")'
    ]);
    if (existingMenu) return true;

    const optionsButton = await this.browser.firstVisible([
      "button[aria-label='Options']",
      "[aria-label*='profile' i]",
      "button:has-text('Profile')",
      "button:has-text('Account')",
      'header button:last-child',
      '.navbar button:last-child'
    ]);

    if (!optionsButton) return false;

    await optionsButton.click();
    await this.browser.sleep(500);

    const openedMenu = await this.browser.firstVisible([
      '[role="menuitem"]:has-text("My Account")',
      'text=My Account'
    ]);

    return !!openedMenu;
  }

  async verifyMyAccountNavigationOutcome() {
    try {
      const menuOpen = await this.ensureOptionsMenuOpen();
      if (!menuOpen) {
        return 'unknown';
      }

      const myAccount = await this.browser.firstVisible([
        '[role="menuitem"]:has-text("My Account")',
        "text=My Account",
        "a:has-text('My Account')",
        "button:has-text('My Account')"
      ]);

      if (!myAccount) {
        return 'unknown';
      }

      await myAccount.click();
      await this.browser.sleep(500);

      const outcome = await this.waitForMyAccountOutcome();
      if (outcome === 'phone_required' || outcome === 'otp_required') {
        logger.info('My Account click redirected to auth flow instead of authenticated account page');
      }

      return outcome;
    } catch (error) {
      logger.warn(`Authenticated access confirmation failed: ${error.message}`);
      return 'unknown';
    }
  }

  async waitForMyAccountOutcome(timeout = 3000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const currentUrl = this.browser.page.url().toLowerCase();

      if (currentUrl.includes('/auth?callbackurl=')) {
        return 'phone_required';
      }

      const phoneInput = await this.browser.firstVisible([
        "input[type='tel']:not([data-index])",
        "input[placeholder*='phone' i]",
        "input[placeholder*='mobile' i]",
        "input[name*='phone' i]"
      ]);
      if (phoneInput) {
        return 'phone_required';
      }

      const otpIndicators = await this.browser.firstVisible([
        "button:has-text('Validate')",
        "button:has-text('Verify')",
        "text=/Enter OTP/i",
        "input[data-index]",
        "input[autocomplete='one-time-code']"
      ]);
      if (otpIndicators) {
        return 'otp_required';
      }

      if (currentUrl.includes('/rcbian/mypage') || currentUrl.endsWith('/rcbian') || currentUrl.includes('/rcbian?')) {
        const myAccountPageVisible = await this.browser.firstVisible([
          'text=My Account',
          'button:has-text("My Orders")',
          'button:has-text("Profile")',
          'button:has-text("My Addresses")'
        ]);

        if (myAccountPageVisible) {
          return 'logged_in';
        }
      }

      await this.browser.page.waitForTimeout(150);
    }

    return 'unknown';
  }

  async confirmAuthenticatedAccess() {
    const outcome = await this.verifyMyAccountNavigationOutcome();
    return outcome === 'logged_in';
  }

  async isLoggedIn() {
    try {
      let state = await this.detectPassiveAuthState();
      if (state === 'phone_required' || state === 'otp_required') {
        return false;
      }

      if (state === 'logged_in') {
        return await this.confirmAuthenticatedAccess();
      }

      if (await this.probeAuthenticatedMenu()) {
        return await this.confirmAuthenticatedAccess();
      }

      return await this.confirmAuthenticatedAccess();
    } catch (error) {
      logger.warn(`Login check failed: ${error.message}`);
      return false;
    }
  }

  async clickAccountMenu() {
    try {
      const accountSelectors = [
        'button:has-text("Account")',
        'button:has-text("My Account")',
        'button:has-text("Login")',
        'button:has-text("Sign In")',
        '[aria-label*="account" i]',
        '[aria-label*="login" i]',
        '.account-menu button',
        '.user-menu button',
        'header button:last-child',
        '.navbar button:last-child'
      ];

      for (const selector of accountSelectors) {
        try {
          const element = await this.browser.firstVisible([selector]);
          if (element) {
            await element.click();
            logger.info(`Clicked account menu using selector: ${selector}`);
            return true;
          }
        } catch (_) {}
      }

      logger.warn('Could not find account/login menu to click');
      return false;
    } catch (error) {
      logger.error(`Error clicking account menu: ${error.message}`);
      return false;
    }
  }

  async detectAndHandleLogin() {
    let state = await this.detectPassiveAuthState();

    if (state === 'unknown') {
      const loggedIn = await this.isLoggedIn();
      if (loggedIn) {
        return true;
      }
      state = await this.detectPassiveAuthState();
    }

    if (state === 'logged_in') {
      const confirmed = await this.confirmAuthenticatedAccess();
      if (confirmed) {
        return true;
      }
      state = await this.detectPassiveAuthState();
    }

    if (state === 'phone_required') {
      await this.fillPhoneAndNext();
    } else if (state === 'otp_required') {
      logger.info('OTP screen already visible; entering OTP wait mode directly');
    } else {
      // Try to trigger login by clicking account menu
      logger.info('No login state detected, attempting to trigger login via account menu...');
      const menuClicked = await this.ensureOptionsMenuOpen();
      if (menuClicked) {
        await this.browser.sleep(500);
        const myAccount = await this.browser.firstVisible([
          '[role="menuitem"]:has-text("My Account")',
          "text=My Account",
          "a:has-text('My Account')",
          "button:has-text('My Account')"
        ]);
        if (myAccount) {
          await myAccount.click();
          await this.browser.sleep(500);
        }
      }
      // Try phone entry after menu click
      await this.fillPhoneAndNext();
    }

    const otpOk = await this.waitForManualOtpSuccess();
    return otpOk;
  }
}

// Standalone Ticket Monitor
class TicketMonitor {
  constructor() {
    this.browser = null;
    this.telegram = new TelegramNotifier();
    this.loginManager = null;
    this.isRunning = false;
    this.startTime = null;
  }

  async start() {
    logger.info('🎟 Starting Standalone Ticket Monitor');
    logger.info(`Initial URL: ${config.website.url}`);
    logger.info(`Monitor URL: ${process.env.MONITOR_URL}`);
    logger.info(`Timeout: ${config.runtime.timeoutMinutes} minutes`);
    
    try {
      await this.telegram.sendMessage(`🎟 *Standalone Ticket Monitor Started*\n\nInitial URL: ${config.website.url}\nMonitor URL: ${process.env.MONITOR_URL}\nTimeout: ${config.runtime.timeoutMinutes} minutes`);
    } catch (error) {
      logger.warn('Telegram notification failed - continuing anyway');
    }

    this.isRunning = true;
    this.startTime = Date.now();

    await this.initializeBrowser();
    await this.monitorTickets();
  }

  async initializeBrowser() {
    try {
      this.browser = new BrowserManager(1, { id: 'ticket-monitor', phone: config.website.loginPhone });
      this.loginManager = new LoginManager(this.browser, this.telegram);

      const initialized = await this.browser.initialize();
      if (!initialized) {
        logger.error('Failed to initialize browser');
        throw new Error('Browser initialization failed');
      }

      logger.info('Browser initialized successfully');
    } catch (error) {
      logger.error(`Browser initialization error: ${error.message}`);
      throw error;
    }
  }

  async monitorTickets() {
    // Navigate to initial URL once
    const navSuccess = await this.navigateToInitialUrl();
    if (!navSuccess) {
      logger.error('Failed to navigate to initial URL');
      await this.telegram.sendMessage('❌ *Initial Navigation Failed*\n\nUnable to navigate to initial URL. Please check your configuration.');
      return;
    }

    // Monitor loop with login check for each refresh
    while (this.isRunning && !this.hasTimedOut()) {
      try {
        // Handle login for each refresh/iteration
        logger.info('Checking login status...');
        const loginSuccess = await this.loginManager.detectAndHandleLogin();
        if (!loginSuccess) {
          logger.warn('Login failed, retrying...');
          await this.sleep(1000);
          continue;
        }
        logger.info('✅ Login successful - attempting to navigate to tickets');

        // Navigate to monitor URL
        const ticketNavSuccess = await this.navigateToTicketUrl();
        if (ticketNavSuccess) {
          logger.info('✅ Successfully navigated to monitor URL and staying on page');
          await this.telegram.sendMessage('🎫 ✅ *Tickets Are Live!*\n\nSuccessfully navigated to ticket booking page.\nBrowser is staying open for manual booking.');
          
          // Keep browser open on ticket page
          await this.keepBrowserOpen();
          return;
        } else {
          logger.warn('Not on monitor URL, retrying navigation...');
          await this.sleep(1000);
        }

      } catch (error) {
        logger.error(`Monitoring error: ${error.message}`);
        await this.sleep(1000);
      }
    }

    if (this.hasTimedOut()) {
      logger.info('⏰ Monitoring timeout reached');
      await this.telegram.sendMessage('⏰ *Monitoring Timeout*\n\nNo tickets found within the timeout period.');
    }
  }

  async navigateToInitialUrl() {
    try {
      await this.browser.navigateToWebsite();
      await this.browser.waitForPageReady();
      logger.info(`Navigated to: ${this.browser.page.url()}`);
      return true;
    } catch (error) {
      logger.error(`Initial navigation error: ${error.message}`);
      return false;
    }
  }

  async navigateToTicketUrl() {
    try {
      const monitorUrl = process.env.MONITOR_URL;
      if (!monitorUrl) {
        logger.error('MONITOR_URL not configured in .env');
        return false;
      }

      logger.info(`Navigating to monitor URL: ${monitorUrl}`);
      await this.browser.page.goto(monitorUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.website.navigationTimeout
      });

      await this.browser.waitForPageReady();
      // await this.sleep(500);

      const currentUrl = this.browser.page.url();
      logger.info(`Current URL after navigation: ${currentUrl}`);

      if (currentUrl.includes(monitorUrl) || this.isTicketPage(currentUrl)) {
        logger.info('✅ Successfully on monitor page');
        return true;
      } else {
        logger.warn(`Not on expected monitor URL. Current: ${currentUrl}, Expected: ${monitorUrl}`);
        return false;
      }

    } catch (error) {
      logger.error(`Monitor URL navigation error: ${error.message}`);
      return false;
    }
  }

  isTicketPage(url) {
    const ticketPageIndicators = [
      'ticket',
      'booking',
      'seat',
      'event',
      'match'
    ];

    return ticketPageIndicators.some(indicator =>
      url.toLowerCase().includes(indicator.toLowerCase())
    );
  }

  async keepBrowserOpen() {
    logger.info('🔄 Keeping browser open on ticket page for manual booking...');

    while (this.isRunning && !this.hasTimedOut()) {
      await this.sleep(60000);
    }

    logger.info('Browser monitoring ended (timeout reached)');
  }

  hasTimedOut() {
    if (!this.startTime) return false;

    const elapsedMinutes = (Date.now() - this.startTime) / 60000;
    return elapsedMinutes >= config.runtime.timeoutMinutes;
  }

  async stop() {
    logger.info('Stopping ticket monitor...');
    this.isRunning = false;

    try {
      if (this.browser) {
        await this.browser.close();
        logger.info('Browser closed');
      }

      await this.telegram.sendMessage('🛑 *Ticket Monitor Stopped*\n\nMonitoring has been terminated.');
    } catch (error) {
      logger.error(`Error during cleanup: ${error.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const monitor = new TicketMonitor();

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT - shutting down gracefully...');
    await monitor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM - shutting down gracefully...');
    await monitor.stop();
    process.exit(0);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  });

  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  });

  try {
    await monitor.start();
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = TicketMonitor;
