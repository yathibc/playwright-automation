const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('ScreenFlowAutomation');

class ScreenFlowAutomation {
  constructor({ browserManager, loginManager, matchDetector, seatSelector, telegramNotifier }) {
    this.browser = browserManager;
    this.login = loginManager;
    this.matchDetector = matchDetector;
    this.seatSelector = seatSelector;
    this.telegram = telegramNotifier;
  }

  async runSkeletonFlow() {
    logger.info('Starting screen-flow skeleton automation');

    const sessionOk = await this.restoreAndValidateSession();
    if (!sessionOk) {
      return this.holdWithReason('Login failed or OTP timeout');
    }

    const matchStatus = await this.matchDetector.discoverMatchAvailability();
    if (!matchStatus.found) {
      return this.holdWithReason('RCB vs SRH match not found');
    }

    if (!matchStatus.available) {
      return this.holdWithReason('RCB vs SRH tickets unavailable');
    }

    const selectedStand = await this.resolveStandPriority(matchStatus.availableStands || []);
    if (!selectedStand) {
      return this.holdWithReason('Neither C Stand nor B Stand was available');
    }

    logger.info(`Proceeding with stand: ${selectedStand}`);
    const selectionResult = await this.seatSelector.runStandSeatFlow(selectedStand);

    if (!selectionResult.success) {
      return this.holdWithReason(selectionResult.reason || 'No valid 2-seat consecutive pair found');
    }

    await this.telegram?.sendMessage?.(`🛒 Seats added to cart in ${selectedStand}. Browser left open for manual checkout.`);
    logger.info('Cart flow reached. Browser should remain open for manual payment.');
    return true;
  }

  async restoreAndValidateSession() {
    const loggedIn = await this.login.detectAndHandleLogin();
    return !!loggedIn;
  }

  async resolveStandPriority(availableStands) {
    const normalized = (availableStands || []).map((s) => String(s).toLowerCase());
    const cStand = config.seats.preferredStand;
    const bStand = config.seats.fallbackStand;

    if (normalized.some((s) => s.includes(cStand.toLowerCase()))) return cStand;
    if (normalized.some((s) => s.includes(bStand.toLowerCase()))) return bStand;

    return null;
  }

  async holdWithReason(reason) {
    logger.warn(reason);
    await this.browser.takeScreenshot(`hold-${String(reason).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
    await this.telegram?.sendMessage?.(`⚠️ ${reason}. Browser left open for manual review.`);
    return false;
  }
}

module.exports = ScreenFlowAutomation;
