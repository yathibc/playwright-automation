const { createModuleLogger } = require('../utils/logger');
const BrowserManager = require('../browser/browser');
const LoginManager = require('../auth/login');
const MatchDetector = require('../detection/matchDetector');
const SeatMapDetector = require('../detection/seatMapDetector');
const SeatSelector = require('../selection/seatSelector');
const EventMonitor = require('../monitoring/eventMonitor');
const TelegramNotifier = require('../notifications/telegram');
const CheckoutFlow = require('../flows/checkoutFlow');
const config = require('../config/config');

const logger = createModuleLogger('ParallelController');

class ParallelSessionController {
  constructor() {
    this.sessions = [];
    this.telegram = new TelegramNotifier();
    this.successfulSessions = [];
    this.isRunning = false;
  }

  async initializeParallelSessions() {
    const enabledAccounts = (config.accounts || []).filter(account => account.enabled !== false);
    logger.info(`Initializing ${enabledAccounts.length} account-backed browser sessions...`);

    const createdSessions = await Promise.all(
      enabledAccounts.map((account, index) => this.createSession(index + 1, account))
    );

    createdSessions.forEach((session, index) => {
      const account = enabledAccounts[index];
      if (session) {
        this.sessions.push(session);
        logger.info(`Session ${index + 1} initialized successfully for account ${account.id}`);
      } else {
        logger.error(`Failed to initialize session ${index + 1} for account ${account.id}`);
      }
    });
    
    logger.info(`${this.sessions.length} sessions ready`);
    return this.sessions.length > 0;
  }

  async createSession(sessionId, account) {
    try {
      const browserManager = new BrowserManager(sessionId, account);
      const loginManager = new LoginManager(browserManager, this.telegram, account);
      const matchDetector = new MatchDetector(browserManager, this.telegram);
      const seatMapDetector = new SeatMapDetector(browserManager);
      const checkoutFlow = new CheckoutFlow({
        browserManager,
        telegramNotifier: this.telegram,
        account
      });
      const seatSelector = new SeatSelector(browserManager, this.telegram);
      const eventMonitor = new EventMonitor(browserManager, matchDetector, seatMapDetector, seatSelector, checkoutFlow);

      const session = {
        id: sessionId,
        browser: browserManager,
        login: loginManager,
        matchDetector: matchDetector,
        seatMapDetector: seatMapDetector,
        seatSelector: seatSelector,
        eventMonitor: eventMonitor,
        checkoutFlow,
        status: 'initialized',
        success: false,
        account,
        deadlineTs: Date.now() + (config.runtime.timeoutMinutes * 60 * 1000),
        monitoringStartedAt: null
      };

      const initialized = await browserManager.initialize();
      if (!initialized) {
        logger.warn(`Session ${sessionId} browser initialization failed`);
        return null;
      }

      const navigated = await browserManager.navigateToWebsite();
      if (!navigated) {
        logger.warn(`Session ${sessionId} website navigation failed`);
        await browserManager.close();
        return null;
      }

      // Ensure authenticated state (session reuse first, OTP fallback)
      const loginStatus = await loginManager.detectAndHandleLogin();
      if (!loginStatus) {
        logger.warn(`Session ${sessionId} login not completed within timeout`);
        await browserManager.takeScreenshot(`login_timeout_session${sessionId}.png`);
        session.needsLogin = true;
      } else {
        logger.info(`Session ${sessionId} authenticated for account ${account.id}`);
        session.needsLogin = false;
        await browserManager.startNetworkCapture();
      }

      session.status = 'ready';
      return session;
    } catch (error) {
      logger.error(`Error creating session ${sessionId}: ${error.message}`);
      return null;
    }
  }

  async startParallelMonitoring() {
    if (this.sessions.length === 0) {
      logger.error('No sessions available for monitoring');
      return false;
    }

    logger.info('Starting parallel monitoring...');
    this.isRunning = true;
    this.successfulSessions = [];

    const sessionPromises = this.sessions.map(session => 
      this.runSessionMonitoring(session)
    );

    await Promise.all(sessionPromises);
    
    return this.successfulSessions.length > 0;
  }

  async runSessionMonitoring(session) {
    if (!this.isRunning) return;

    logger.info(`Starting monitoring in session ${session.id}`);
    session.status = 'monitoring';
    session.monitoringStartedAt = Date.now();
    
    try {
      await this.telegram.sendSessionStatus('Monitoring started', session.id);

      const success = await this.monitorSession(session);
      
      if (success) {
        this.successfulSessions.push(session);
        session.success = true;
        session.status = 'success';
        
        logger.info(`Session ${session.id} successfully booked tickets for account ${session.account?.id || session.id}`);
        await this.telegram.sendSessionStatus(`Tickets booked successfully for account ${session.account?.id || session.id}`, session.id);
      } else {
        session.status = 'failed';
        logger.info(`Session ${session.id} monitoring completed without success`);
      }
    } catch (error) {
      logger.error(`Error in session ${session.id}: ${error.message}`);
      session.status = 'error';
      await this.telegram.sendError(error.message, `Session ${session.id}`);
    }
  }

  async monitorSession(session) {
    logger.info(`Session ${session.id} monitoring preferred stand ${session.account?.preferredStand || config.seats.preferredStand}`);
    
    const monitoringStrategies = [
      () => this.monitorEventDriven(session),
      () => this.monitorPolling(session)
    ];

    for (const strategy of monitoringStrategies) {
      if (!this.isRunning) return false;
      
      try {
        const success = await strategy();
        if (success) {
          return true;
        }
      } catch (error) {
        logger.error(`Strategy failed for session ${session.id}: ${error.message}`);
      }
    }

    return false;
  }

  getRemainingMs(session) {
    return Math.max(0, (session.deadlineTs || 0) - Date.now());
  }

  hasTimeLeft(session) {
    return this.getRemainingMs(session) > 0;
  }

  async monitorEventDriven(session) {
    logger.info(`Session ${session.id} using event-driven monitoring`);
    
    try {
      await session.eventMonitor.startEventDrivenMonitoring();
      
      return new Promise((resolve) => {
        const timeLimit = this.getRemainingMs(session);
        if (timeLimit <= 0) {
          session.eventMonitor.stop();
          resolve(false);
          return;
        }

        const timeout = setTimeout(() => {
          session.eventMonitor.stop();
          resolve(false);
        }, timeLimit);

        const checkSuccess = async () => {
          if (!this.isRunning || !this.hasTimeLeft(session)) {
            clearTimeout(timeout);
            resolve(false);
            return;
          }

          if (session.success) {
            clearTimeout(timeout);
            resolve(true);
            return;
          }

          if (session.eventMonitor.hasBookingSucceeded()) {
            clearTimeout(timeout);
            resolve(true);
            return;
          }

          setTimeout(checkSuccess, 2000);
        };

        checkSuccess();
      });
    } catch (error) {
      logger.error(`Event-driven monitoring failed for session ${session.id}: ${error.message}`);
      return false;
    }
  }

  async monitorPolling(session) {
    logger.info(`Session ${session.id} using polling monitoring`);

    let attempt = 0;
    while (this.isRunning && this.hasTimeLeft(session)) {
      attempt += 1;

      try {
        const seatSuccess = await this.processSeatSelection(session);
        if (seatSuccess) {
          return true;
        }

        await session.browser.page.waitForTimeout(Math.min(config.monitoring.pollIntervalMs, this.getRemainingMs(session)));
        if (attempt % 30 === 0) {
          logger.info(`Session ${session.id} polling attempt ${attempt}, remaining ${Math.ceil(this.getRemainingMs(session) / 1000)}s`);
        }
      } catch (error) {
        logger.debug(`Polling attempt ${attempt} failed for session ${session.id}: ${error.message}`);
      }
    }

    return false;
  }

  async processSeatSelection(session) {
    try {
      if (!this.hasTimeLeft(session)) {
        logger.warn(`Session ${session.id} has exhausted global timeout before seat selection`);
        return false;
      }

      return await this.attemptMatchBookingFlow(session);
    } catch (error) {
      logger.error(`Seat selection failed in session ${session.id}: ${error.message}`);
      return false;
    }
  }

  async attemptMatchBookingFlow(session) {
    const matchUrl = config.match.matchUrl;
    const maxAttempts = config.seats.matchRetryAttempts;    
    let attempt = 0;

    while (attempt < maxAttempts && this.hasTimeLeft(session)) {
      attempt += 1;
      logger.info(`Session ${session.id} booking attempt ${attempt}/${maxAttempts} at ${matchUrl}`);

      const navigated = await this.goToMatchPage(session, matchUrl);
      if (!navigated) continue;

      await this.clickContinuePopup(session);

      const stand = await this.selectStandForMatch(session);
      if (!stand) continue;

      const ticketsSelected = await this.selectTicketCount(session, config.seats.requiredConsecutiveSeats || 2);
      if (!ticketsSelected) continue;

      const continued = await this.clickMatchContinue(session);
      if (!continued) continue;

      const seatMapLoaded = await session.seatMapDetector.waitForSeatMapLoad();
      if (!seatMapLoaded) {
        logger.warn(`Seat map failed to load after match navigation in session ${session.id}`);
        continue;
      }

      const seatMap = await session.seatMapDetector.detectAndInitializeSeatMap();
      if (!seatMap) {
        logger.warn(`Unable to initialize seat map after selecting stand in session ${session.id}`);
        continue;
      }

      const selectionResult = await session.seatSelector.runStandSeatFlow(stand, seatMap);
      if (!selectionResult.success) {
        logger.warn(`Seat selection could not complete (${selectionResult.reason || 'unknown'}) in session ${session.id}`);
        continue;
      }

      try {
        return await session.checkoutFlow.runFromCurrentPage();
      } catch (error) {
        logger.error(`Checkout flow failed in session ${session.id}: ${error.message}`);
        continue;
      }
    }

    return false;
  }

  async goToMatchPage(session, matchUrl) {
    try {
      await session.browser.page.goto(matchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.website.navigationTimeout
      });
      await session.browser.waitForPageReady();
      await session.browser.page.waitForTimeout(750);
      return true;
    } catch (error) {
      logger.warn(`Failed to navigate to match URL in session ${session.id}: ${error.message}`);
      return false;
    }
  }

  async clickContinuePopup(session) {
    try {
      const continueBtn = await session.browser.waitForAnyVisible([
        "xpath=//button/../*[contains(text(),'Continue')]",
        "button:has-text('Continue')",
        "button:has-text('Proceed')"
      ], 2500, 200);

      if (continueBtn) {
        await continueBtn.click();
        await session.browser.page.waitForTimeout(400);
        return true;
      }
    } catch (error) {
      logger.debug(`Continue popup handling failed in session ${session.id}: ${error.message}`);
    }

    return false;
  }

  async selectStandForMatch(session) {
    try {
      const standLocators = await session.browser.page.locator("xpath=//p[text()='CATEGORY']/following-sibling::div[1]/div/div/p[1]").all();
      if (!standLocators.length) {
        logger.warn(`No stand options found in session ${session.id}`);
        return null;
      }

      const standPreferences = this.getStandPreferences(session);

      const standEntries = [];
      for (const locator of standLocators) {
        const text = ((await locator.textContent()) || '').trim();
        if (text) {
          standEntries.push({ text, locator });
        }
      }

      for (const preference of standPreferences) {
        const normalizedPreference = preference?.toLowerCase();
        if (!normalizedPreference) continue;

        for (let i = standEntries.length - 1; i >= 0; i -= 1) {
          const stand = standEntries[i];
          if (stand.text.toLowerCase().includes(normalizedPreference)) {
            await stand.locator.click();
            await session.browser.page.waitForTimeout(400);
            logger.info(`Selected stand ${stand.text} for session ${session.id}`);
            return stand.text;
          }
        }
      }

      const fallbackStand = standEntries[standEntries.length - 1];
      await fallbackStand.locator.click();
      await session.browser.page.waitForTimeout(400);
      logger.info(`Defaulted to stand ${fallbackStand.text} for session ${session.id}`);
      return fallbackStand.text;
    } catch (error) {
      logger.warn(`Stand selection failed in session ${session.id}: ${error.message}`);
      return null;
    }
  }

  getStandPreferences(session) {
    const account = session.account || {};
    const preferences = [
      account.preferredStand,
      account.fallbackStand,
      config.seats.preferredStand,
      config.seats.fallbackStand
    ].filter(Boolean);

    return [...new Set(preferences.map((p) => p.trim()))];
  }

  async selectTicketCount(session, quantity) {
    try {
      const section = session.browser.page.locator("xpath=//p[text()='How many tickets?']/following-sibling::div[2]").first();
      if (!section) return false;
      const buttons = await section.locator('button').all();

      for (const button of buttons) {
        const text = ((await button.textContent()) || '').trim();
        if (!text) continue;

        if (text === String(quantity) || text.toLowerCase().includes(String(quantity))) {
          await button.click();
          await session.browser.page.waitForTimeout(300);
          return true;
        }
      }
    } catch (error) {
      logger.warn(`Ticket count selection failed in session ${session.id}: ${error.message}`);
    }

    return false;
  }

  async clickMatchContinue(session) {
    try {
      const continueBtn = await session.browser.waitForAnyVisible([
        "button:has-text('Continue')",
        "button:has-text('Proceed')",
        "button:has-text('Next')"
      ], 2500, 200);

      if (continueBtn) {
        await continueBtn.click();
        await session.browser.page.waitForTimeout(600);
        return true;
      }
    } catch (error) {
      logger.warn(`Failed to click continue button in session ${session.id}: ${error.message}`);
    }

    return false;
  }

  async completeSeatSelectionAndCheckout(session, seatMap, options = {}) {
    const {
      sourceLabel = 'seat selection flow'
    } = options;

    let selectionResult = await session.seatSelector.selectConsecutiveSeats(seatMap);

    if (!selectionResult) {
      logger.info(`No selectable seat pair found in session ${session.id} for ${sourceLabel}`);
      return false;
    }

    logger.info(`Seats selected successfully in session ${session.id} via ${selectionResult.strategy} (${sourceLabel})`);
    return await session.checkoutFlow.runFromCurrentPage();
  }

  async cleanup() {
    logger.info('Cleaning up parallel sessions...');
    
    this.isRunning = false;
    
    for (const session of this.sessions) {
      try {
        session.eventMonitor?.stop();
        
        // Close browser if no successful booking (cleanup will be called from main)
        // Browser will remain open if tickets were successfully booked
        if (!session.success) {
          logger.info(`Closing browser for session ${session.id} (no successful booking)`);
          try {
            await session.browser.close();
          } catch (closeError) {
            logger.warn(`Browser close error, trying force close: ${closeError.message}`);
            // Force close if normal close fails
            if (session.browser.context) {
              await session.browser.context().close();
            }
            if (session.browser.process) {
              session.browser.process.kill('SIGKILL');
            }
          }
        } else {
          logger.info(`Keeping browser open for session ${session.id} (successful booking)`);
        }
      } catch (error) {
        logger.error(`Error cleaning up session ${session.id}: ${error.message}`);
      }
    }
    
    this.sessions = [];
    this.successfulSessions = [];
    
    logger.info('Cleanup completed');
  }

  getSessionStatus() {
    return this.sessions.map(session => ({
      id: session.id,
      status: session.status,
      success: session.success,
      accountId: session.account?.id || null,
      phone: session.account?.phone || null
    }));
  }

  async preloadSessions() {
    logger.info('Preloading sessions before ticket drop...');
    
    const preloadSuccess = await this.initializeParallelSessions();
    
    if (preloadSuccess) {
      logger.info('Sessions preloaded successfully');
      return true;
    } else {
      logger.error('Failed to preload sessions');
      return false;
    }
  }
}

module.exports = ParallelSessionController;
