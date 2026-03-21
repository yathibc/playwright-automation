const TelegramBot = require('node-telegram-bot-api');
const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('Telegram');

class TelegramNotifier {
  constructor() {
    this.bot = null;
    this.chatId = config.telegram.chatId;
    this.enabled = !!(config.telegram.botToken && config.telegram.chatId);
    
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

  async sendLoginRequired() {
    const message = '🔐 *Login Required*\n\nPlease login and complete OTP verification.\n\nAutomation will resume after login.';
    await this.sendMessage(message);
  }

  async sendTicketsAdded(stand, seats, sessionId) {
    const message = `🎟 *Tickets Added to Cart*\n\n` +
      `Stand: ${stand}\n` +
      `Seats: ${seats.join(' & ')}\n` +
      `Session: ${sessionId}\n\n` +
      `Browser left open for manual checkout.`;
    await this.sendMessage(message);
  }

  async sendError(error, context = '') {
    const message = `❌ *Error*\n\n${context ? `${context}\n\n` : ''}${error}`;
    await this.sendMessage(message);
  }

  async sendSessionStatus(status, sessionId) {
    const message = `🤖 *Session ${sessionId}*\n\nStatus: ${status}`;
    await this.sendMessage(message);
  }

  async sendMatchFound(matchDetails) {
    const message = `🏏 *Match Detected*\n\n${matchDetails}`;
    await this.sendMessage(message);
  }
}

module.exports = TelegramNotifier;
