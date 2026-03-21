require('dotenv').config();
const { createModuleLogger } = require('./utils/logger');
const ParallelSessionController = require('./session/parallelController');
const TelegramNotifier = require('./notifications/telegram');
const config = require('./config/config');

const logger = createModuleLogger('Main');

class TicketAutomationSystem {
  constructor() {
    this.parallelController = new ParallelSessionController();
    this.telegram = new TelegramNotifier();
    this.isRunning = false;
  }

  async start() {
    logger.info('🎟 Starting Ticket Booking Automation System');
    logger.info(`Runtime Timeout: ${config.runtime.timeoutMinutes} minutes`);
    logger.info(`Max Parallel Sessions: ${config.sessions.maxParallel}`);
    logger.info(`Configured Accounts: ${(config.accounts || []).map(account => account.id).join(', ')}`);
    logger.info(`Target Match: RCB vs SRH`);
    logger.info(`Preferred Stands: ${config.seats.preferredStand} then ${config.seats.fallbackStand}`);
    
    try {
      await this.telegram.sendMessage(`🚀 *Ticket Automation Started*\n\nMonitoring for RCB vs SRH match\nAccounts: ${(config.accounts || []).map(account => account.id).join(', ')}\nPreferred stands: ${config.seats.preferredStand}, then ${config.seats.fallbackStand}`);
    } catch (error) {
      logger.warn('Telegram notification failed - continuing anyway');
    }

    this.isRunning = true;

    const success = await this.executeAutomation();

    if (success) {
      logger.info('🎉 Automation completed successfully');
      await this.telegram.sendMessage('✅ *Automation Completed*\n\nTickets have been added to cart. Browser left open for manual checkout.');
    } else {
      logger.info('⏰ Automation completed without success');
      await this.telegram.sendMessage('⏰ *Automation Ended*\n\nMatch not found / tickets unavailable / no 2 consecutive seats. Screenshot/log captured. Browser left open for manual review.');
    }

    await this.cleanup();
  }

  async executeAutomation() {
    try {
      const preloadSuccess = await this.parallelController.preloadSessions();
      if (!preloadSuccess) {
        logger.error('Failed to preload sessions');
        return false;
      }

      const monitoringSuccess = await this.parallelController.startParallelMonitoring();
      
      if (monitoringSuccess) {
        logger.info('🎫 Tickets successfully booked!');
        // Keep browser open on successful ticket booking
        logger.info('🎫 Tickets booked successfully! Browser left open for manual payment checkout.');
        // Don't close browser - keep it open for manual checkout
        return true;
      } else {
        logger.info('No tickets were booked during this window');
        // Close browser since no tickets were booked
        // await this.cleanup();
        
        // Force exit to prevent Jenkins hanging
        // logger.info('Forcing process exit to prevent Jenkins hanging');
        // setTimeout(() => {
        //   process.exit(0);
        // }, 500);
        
        return false;
      }
    } catch (error) {
      logger.error(`Automation execution failed: ${error.message}`);
      await this.telegram.sendError(error.message, 'Main Automation');
      
      // Force exit to prevent Jenkins hanging
      logger.info('Forcing process exit due to error to prevent Jenkins hanging');
      setTimeout(() => {
        process.exit(1);
      }, 500);
      
      return false;
    }
  }

  async cleanup() {
    logger.info('Starting cleanup...');
    
    try {
      // Only cleanup parallel controller - browser is handled based on success/failure
      await this.parallelController.cleanup();
      logger.info('Cleanup completed');
    } catch (error) {
      logger.error(`Cleanup failed: ${error.message}`);
    }
    
    this.isRunning = false;
  }

  async stop() {
    logger.info('Stopping automation system...');
    this.isRunning = false;
    await this.cleanup();
    
    // Force exit to prevent Jenkins hanging
    logger.info('Forcing process exit to prevent Jenkins hanging');
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      timeWindow: { timeoutMinutes: config.runtime.timeoutMinutes },
      sessions: this.parallelController.getSessionStatus()
    };
  }
}

async function main() {
  const system = new TicketAutomationSystem();

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT - shutting down gracefully...');
    await system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM - shutting down gracefully...');
    await system.stop();
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
    await system.start();
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = TicketAutomationSystem;
