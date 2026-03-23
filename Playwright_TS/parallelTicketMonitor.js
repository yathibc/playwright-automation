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
  sessions: {
    maxParallel: parseInt(process.env.MAX_PARALLEL_SESSIONS) || 3
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }
};

// Account Management
function loadAccounts() {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Try to load from accounts.json if it exists
    const accountsPath = path.join(process.cwd(), 'accounts.json');
    if (fs.existsSync(accountsPath)) {
      const parsed = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      const enabledAccounts = (parsed.accounts || []).filter(account => account && account.enabled !== false);
      if (enabledAccounts.length) {
        return enabledAccounts.map((account, index) => ({
          id: account.id || `acc${index + 1}`,
          phone: account.phone || process.env.LOGIN_PHONE || '7899179393',
          enabled: account.enabled !== false,
          preferredStand: account.preferredStand || process.env.PREFERRED_STAND || 'C Stand',
          fallbackStand: account.fallbackStand || process.env.FALLBACK_STAND || 'B Stand'
        }));
      }
    }
  } catch (_) {}

  // Fallback to single account
  return [{
    id: 'acc1',
    phone: process.env.LOGIN_PHONE || '7899179393',
    enabled: true,
    preferredStand: process.env.PREFERRED_STAND || 'C Stand',
    fallbackStand: process.env.FALLBACK_STAND || 'B Stand'
  }];
}

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
  constructor(sessionId, account) {
    this.sessionId = sessionId;
    this.account = account;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isActive = false;
  }

  async initialize() {
    try {
      logger.info(`Initializing browser session ${this.sessionId} for account ${this.account.id}`);

      const { chromium } = require('playwright');
      
      this.browser = await chromium.launch({
        headless: process.env.HEADLESS === 'true',
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check'
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
      this.isActive = true;

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
      this.isActive = false;
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

      if (currentUrl.includes('/auth?callbackurl=/rcbian')) {
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

// Parallel Session Controller
class ParallelSessionController {
  constructor() {
    this.sessions = [];
    this.telegram = new TelegramNotifier();
    this.isRunning = false;
    this.startTime = null;
  }

  async initializeSessions() {
    const accounts = loadAccounts();
    const maxSessions = Math.min(accounts.length, config.sessions.maxParallel);
    
    logger.info(`Initializing ${maxSessions} parallel sessions`);
    
    for (let i = 0; i < maxSessions; i++) {
      const account = accounts[i];
      const browserManager = new BrowserManager(i + 1, account);
      const loginManager = new LoginManager(browserManager, this.telegram);
      
      const initialized = await browserManager.initialize();
      if (initialized) {
        this.sessions.push({
          browserManager,
          loginManager,
          account,
          isActive: true,
          foundTickets: false
        });
        logger.info(`Session ${i + 1} initialized for account ${account.id}`);
      } else {
        logger.error(`Failed to initialize session ${i + 1}`);
      }
    }

    logger.info(`Successfully initialized ${this.sessions.length} sessions`);
    return this.sessions.length > 0;
  }

  async startParallelMonitoring() {
    if (this.sessions.length === 0) {
      logger.error('No active sessions to monitor');
      return false;
    }

    logger.info(`Starting parallel monitoring with ${this.sessions.length} sessions`);
    
    // Start monitoring in parallel for each session
    const monitoringPromises = this.sessions.map(session => 
      this.monitorSession(session)
    );

    // Wait for any session to find tickets
    try {
      await Promise.race(monitoringPromises);
      return true;
    } catch (error) {
      logger.error(`Parallel monitoring error: ${error.message}`);
      return false;
    }
  }

  async monitorSession(session) {
    const { browserManager, loginManager, account } = session;
    
    try {
      // Navigate to initial URL
      const navSuccess = await browserManager.navigateToWebsite();
      if (!navSuccess) {
        logger.warn(`Session ${account.id}: Failed to navigate to initial URL`);
        return false;
      }

      // Monitor loop for this session
      while (this.isRunning && !this.hasTimedOut() && !session.foundTickets) {
        try {
          // Handle login if needed
          const loginSuccess = await loginManager.detectAndHandleLogin();
          if (!loginSuccess) {
            logger.warn(`Session ${account.id}: Login failed, retrying...`);
            await browserManager.sleep(1000);
            continue;
          }

          // Navigate to monitor URL
          const ticketNavSuccess = await this.navigateToTicketUrl(browserManager);
          if (ticketNavSuccess) {
            logger.info(`🎫 Session ${account.id}: Successfully navigated to monitor URL!`);
            session.foundTickets = true;
            
            await this.telegram.sendMessage(`🎫 ✅ *Tickets Found by ${account.id}!*\n\nSuccessfully navigated to ticket booking page.\nBrowser is staying open for manual booking.`);
            
            // Keep browser open for this session
            await this.keepBrowserOpen(browserManager, account);
            return true;
          } else {
            logger.debug(`Session ${account.id}: Not on monitor URL, retrying...`);
            await browserManager.sleep(1000);
          }

        } catch (error) {
          logger.error(`Session ${account.id}: Monitoring error: ${error.message}`);
          await browserManager.sleep(1000);
        }
      }

      return false;
    } catch (error) {
      logger.error(`Session ${account.id}: Fatal error: ${error.message}`);
      return false;
    }
  }

  async navigateToTicketUrl(browserManager) {
    try {
      const monitorUrl = process.env.MONITOR_URL;
      if (!monitorUrl) {
        logger.error('MONITOR_URL not configured in .env');
        return false;
      }

      await browserManager.page.goto(monitorUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.website.navigationTimeout
      });

      await browserManager.waitForPageReady();
      await browserManager.sleep(500);

      const currentUrl = browserManager.page.url();

      if (currentUrl.includes(monitorUrl) || this.isTicketPage(currentUrl)) {
        return true;
      } else {
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

  async keepBrowserOpen(browserManager, account) {
    logger.info(`🔄 Keeping browser open for ${account.id} on ticket page...`);

    while (this.isRunning && !this.hasTimedOut()) {
      await browserManager.sleep(60000);
    }

    logger.info(`Browser monitoring ended for ${account.id}`);
  }

  hasTimedOut() {
    if (!this.startTime) return false;

    const elapsedMinutes = (Date.now() - this.startTime) / 60000;
    return elapsedMinutes >= config.runtime.timeoutMinutes;
  }

  async cleanup() {
    logger.info('Cleaning up all sessions...');
    
    for (const session of this.sessions) {
      try {
        await session.browserManager.close();
      } catch (error) {
        logger.error(`Error cleaning up session ${session.account.id}: ${error.message}`);
      }
    }
    
    this.sessions = [];
    logger.info('Cleanup completed');
  }

  getSessionStatus() {
    return this.sessions.map(session => ({
      accountId: session.account.id,
      isActive: session.isActive,
      foundTickets: session.foundTickets,
      currentUrl: session.browserManager.page ? session.browserManager.page.url() : null
    }));
  }
}

// Main Parallel Ticket Monitor
class ParallelTicketMonitor {
  constructor() {
    this.parallelController = new ParallelSessionController();
    this.telegram = new TelegramNotifier();
    this.isRunning = false;
    this.startTime = null;
  }

  async start() {
    logger.info('🎟 Starting Parallel Ticket Monitor');
    logger.info(`Max Parallel Sessions: ${config.sessions.maxParallel}`);
    logger.info(`Initial URL: ${config.website.url}`);
    logger.info(`Monitor URL: ${process.env.MONITOR_URL}`);
    logger.info(`Timeout: ${config.runtime.timeoutMinutes} minutes`);
    
    const accounts = loadAccounts();
    logger.info(`Configured Accounts: ${accounts.map(account => account.id).join(', ')}`);

    try {
      await this.telegram.sendMessage(`🚀 *Parallel Ticket Monitor Started*\n\nAccounts: ${accounts.map(account => account.id).join(', ')}\nMax Sessions: ${config.sessions.maxParallel}\nMonitor URL: ${process.env.MONITOR_URL}\nTimeout: ${config.runtime.timeoutMinutes} minutes`);
    } catch (error) {
      logger.warn('Telegram notification failed - continuing anyway');
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.parallelController.isRunning = true;
    this.parallelController.startTime = this.startTime;

    const success = await this.executeParallelMonitoring();

    if (success) {
      logger.info('🎉 Parallel monitoring completed successfully');
      await this.telegram.sendMessage('✅ *Parallel Monitoring Completed*\n\nTickets have been found and browsers are open for manual booking.');
    } else {
      logger.info('⏰ Parallel monitoring completed without success');
      await this.telegram.sendMessage('⏰ *Parallel Monitoring Ended*\n\nNo tickets found within timeout period.');
    }

    await this.cleanup();
  }

  async executeParallelMonitoring() {
    try {
      const initSuccess = await this.parallelController.initializeSessions();
      if (!initSuccess) {
        logger.error('Failed to initialize sessions');
        return false;
      }

      const monitoringSuccess = await this.parallelController.startParallelMonitoring();
      
      if (monitoringSuccess) {
        logger.info('🎫 Tickets found by one of the sessions!');
        return true;
      } else {
        logger.info('No tickets were found during parallel monitoring');
        return false;
      }
    } catch (error) {
      logger.error(`Parallel monitoring execution failed: ${error.message}`);
      await this.telegram.sendError(error.message, 'Parallel Monitoring');
      return false;
    }
  }

  async cleanup() {
    logger.info('Starting cleanup...');
    
    try {
      await this.parallelController.cleanup();
      logger.info('Cleanup completed');
    } catch (error) {
      logger.error(`Cleanup failed: ${error.message}`);
    }
    
    this.isRunning = false;
  }

  async stop() {
    logger.info('Stopping parallel ticket monitor...');
    this.isRunning = false;
    this.parallelController.isRunning = false;
    await this.cleanup();
    
    await this.telegram.sendMessage('🛑 *Parallel Ticket Monitor Stopped*\n\nMonitoring has been terminated.');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      timeWindow: { timeoutMinutes: config.runtime.timeoutMinutes },
      sessions: this.parallelController.getSessionStatus()
    };
  }
}

// Main execution
async function main() {
  const monitor = new ParallelTicketMonitor();

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

module.exports = ParallelTicketMonitor;
