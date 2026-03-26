const TelegramBot = require('node-telegram-bot-api');
const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('Telegram');

class TelegramNotifier {
  constructor() {
    this.bot = null;
    this.chatId = config.telegram.chatId;
    this.enabled = !!(config.telegram.enabled && config.telegram.botToken && config.telegram.chatId);

    if (this.enabled) {
      this.bot = new TelegramBot(config.telegram.botToken);
      logger.info('Telegram bot initialized');
    } else {
      logger.warn('Telegram bot not configured - notifications disabled');
    }
  }

  async sendMessage(message, options = {}) {
    if (!this.enabled) {
      logger.debug(`Telegram disabled: ${message}`);
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        ...options
      });
      logger.info(`Telegram message sent: ${message.substring(0, 50)}...`);
    } catch (error) {
      logger.error(`Failed to send Telegram message: ${error.message}`);
    }
  }

  async sendLoginRequired(accountId) {
    const message = `🔐 *Login Required*\n\nAccount: ${accountId}\nPlease complete OTP verification.\n\nAutomation will resume after login.`;
    await this.sendMessage(message);
  }

  async sendLoginSuccess(accountId) {
    const message = `✅ *Login Successful*\n\nAccount: ${accountId}\nAuthenticated and ready.`;
    await this.sendMessage(message);
  }

  async sendLoginFailed(accountId) {
    const message = `❌ *Login Failed*\n\nAccount: ${accountId}\nLogin timed out or failed.`;
    await this.sendMessage(message);
  }

  async sendTicketsAdded(stand, seats, accountId) {
    const message = `🎟 *Tickets Added to Cart!*\n\n` +
      `Account: ${accountId}\n` +
      `Stand: ${stand}\n` +
      `Seats: ${seats.join(' & ')}\n\n` +
      `Browser left open for manual checkout.`;
    await this.sendMessage(message);
  }

  async sendError(error, context = '') {
    const message = `❌ *Error*\n\n${context ? `${context}\n\n` : ''}${error}`;
    await this.sendMessage(message);
  }

  async sendSessionStatus(status, accountId) {
    const message = `🤖 *Session ${accountId}*\n\nStatus: ${status}`;
    await this.sendMessage(message);
  }

  async sendMatchFound(matchDetails) {
    const message = `🏏 *Match Detected*\n\n${matchDetails}`;
    await this.sendMessage(message);
  }

  async sendCheckoutReached(accountId) {
    const message = `💳 *Checkout Page Reached*\n\nAccount: ${accountId}\nComplete payment within ~8 minutes.\nBrowser left open.`;
    await this.sendMessage(message);
  }

  async sendHardStop(accountId, reason) {
    const message = `🛑 *Hard Limit Reached*\n\nAccount: ${accountId}\nReason: ${reason}\n\nCannot proceed with this account.`;
    await this.sendMessage(message);
  }

  async sendTimeout(accountId) {
    const message = `⏰ *Global Timeout*\n\nAccount: ${accountId}\nBooking flow did not complete within the time window.`;
    await this.sendMessage(message);
  }

  async sendStartup(accounts, matchName, stands) {
    const message = `🚀 *Automation Started v2.1*\n\n` +
      `Accounts: ${accounts.join(', ')}\n` +
      `Target: ${matchName}\n` +
      `Stands: ${stands.join(' → ')}\n` +
      `Parallel sessions: ${accounts.length}`;
    await this.sendMessage(message);
  }

  async sendSummary(successes, failures) {
    const total = successes.length + failures.length;
    let message = `📊 *Final Results*\n\n` +
      `Total: ${total} | ✅ ${successes.length} | ❌ ${failures.length}\n`;
    if (successes.length > 0) message += `\nSuccess: ${successes.join(', ')}`;
    if (failures.length > 0) message += `\nFailed: ${failures.join(', ')}`;
    await this.sendMessage(message);
  }
}

module.exports = TelegramNotifier;