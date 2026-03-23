require('dotenv').config();
const { createModuleLogger } = require('../utils/logger');
const BrowserManager = require('../browser/browser');
const LoginManager = require('../auth/login');
const TelegramNotifier = require('../notifications/telegram');
const config = require('../config/config');

const logger = createModuleLogger('TicketMonitor');

class TicketMonitor {
  constructor() {
    this.browser = null;
    this.telegram = new TelegramNotifier();
    this.loginManager = null;
    this.isRunning = false;
    this.startTime = null;
  }

  async start() {
    logger.info('🎟 Starting Ticket Monitor');
    logger.info(`Initial URL: ${config.website.url}`);
    logger.info(`Monitor URL: ${process.env.MONITOR_URL}`);
    logger.info(`Timeout: ${config.runtime.timeoutMinutes} minutes`);

    try {
      await this.telegram.sendMessage(`🎟 *Ticket Monitor Started*\n\nInitial URL: ${config.website.url}\nMonitor URL: ${process.env.MONITOR_URL}\nTimeout: ${config.runtime.timeoutMinutes} minutes`);
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
    // Navigate to initial URL and handle login once at the beginning
    const navSuccess = await this.navigateToInitialUrl();
    if (!navSuccess) {
      logger.error('Failed to navigate to initial URL');
      await this.telegram.sendMessage('❌ *Initial Navigation Failed*\n\nUnable to navigate to initial URL. Please check your configuration.');
      return;
    }

    // Now monitor the ticket URL in a loop
    while (this.isRunning && !this.hasTimedOut()) {
      try {

        // Handle login if needed
        const loginSuccess = await this.handleLogin();
        if (!loginSuccess) {
          logger.error('Login failed');
          await this.telegram.sendMessage('❌ *Login Failed*\n\nUnable to complete login. Please check credentials or try manually.');
          return;
        }
        // Navigate to ticket URL
        const ticketNavSuccess = await this.navigateToTicketUrl();
        if (ticketNavSuccess) {
          logger.info('✅ Successfully navigated to ticket URL and staying on page');
          await this.telegram.sendMessage('🎫 ✅ *Tickets Are Live!*\n\nSuccessfully navigated to ticket booking page.\nBrowser is staying open for manual booking.');

          // Keep browser open on ticket page
          await this.keepBrowserOpen();
          return;
        } else {
          logger.warn('Not on ticket URL, retrying navigation...');
          await this.sleep(3000);
        }

      } catch (error) {
        logger.error(`Monitoring error: ${error.message}`);
        await this.sleep(3000);
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

  async handleLogin() {
    try {
      const isLoggedIn = await this.loginManager.isLoggedIn();
      if (isLoggedIn) {
        logger.info('Already logged in');
        return true;
      }

      const loginSuccess = await this.loginManager.detectAndHandleLogin();
      if (loginSuccess) {
        logger.info('Login successful');
        return true;
      }

      logger.warn('Login failed');
      return false;
    } catch (error) {
      logger.error(`Login error: ${error.message}`);
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
      await this.sleep(3000); // Wait 3 seconds for page to fully load

      const currentUrl = this.browser.page.url();
      logger.info(`Current URL after navigation: ${currentUrl}`);

      // Check if we're still on the same monitor URL
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

    // Keep browser open until manually stopped or timeout
    while (this.isRunning && !this.hasTimedOut()) {
      await this.sleep(60000); // Check every 1 minute for timeout
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

  getStatus() {
    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      elapsedMinutes: this.startTime ? Math.floor((Date.now() - this.startTime) / 60000) : 0,
      timeoutMinutes: config.runtime.timeoutMinutes,
      hasTimedOut: this.hasTimedOut(),
      currentUrl: this.browser ? this.browser.page.url() : null
    };
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
