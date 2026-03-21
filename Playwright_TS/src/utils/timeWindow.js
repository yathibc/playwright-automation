const { createModuleLogger } = require('./logger');
const config = require('../config/config');
const moment = require('moment');

const logger = createModuleLogger('TimeWindow');

class TimeWindowManager {
  constructor() {
    this.timeoutMinutes = config.runtime.timeoutMinutes;
    this.startTime = moment();
    this.endTime = moment().add(this.timeoutMinutes, 'minutes');
    this.isActive = false;
  }

  parseTime(timeString) {
    return moment(timeString, 'HH:mm');
  }

  getCurrentTime() {
    return moment();
  }

  isInWindow() {
    const now = this.getCurrentTime();
    return now.isSameOrAfter(this.startTime) && now.isBefore(this.endTime);
  }

  getTimeUntilWindow() {
    const now = this.getCurrentTime();
    return this.startTime.diff(now, 'milliseconds');
  }

  getTimeUntilWindowEnds() {
    const now = this.getCurrentTime();
    return this.endTime.diff(now, 'milliseconds');
  }

  formatDuration(milliseconds) {
    const duration = moment.duration(milliseconds);
    const hours = Math.floor(duration.asHours());
    const minutes = duration.minutes();
    const seconds = duration.seconds();
    
    let formatted = '';
    if (hours > 0) formatted += `${hours}h `;
    if (minutes > 0) formatted += `${minutes}m `;
    formatted += `${seconds}s`;
    
    return formatted.trim();
  }

  async waitForWindow() {
    const timeUntil = this.getTimeUntilWindow();
    
    if (timeUntil <= 0) {
      logger.info('Already within runtime window');
      return true;
    }
    
    const formattedDuration = this.formatDuration(timeUntil);
    logger.info(`Waiting ${formattedDuration} until runtime window starts`);
    
    return new Promise((resolve) => {
      setTimeout(() => {
        logger.info('Runtime window started');
        resolve(true);
      }, timeUntil);
    });
  }

  async monitorWindow(callback) {
    logger.info(`Starting time window monitoring (${this.timeoutMinutes} minutes timeout)`);
    
    const checkWindow = async () => {
      const inWindow = this.isInWindow();
      
      if (inWindow && !this.isActive) {
        logger.info('Entered runtime window');
        this.isActive = true;
        
        try {
          await callback();
        } catch (error) {
          logger.error(`Error during window execution: ${error.message}`);
        }
        
        this.isActive = false;
      } else if (!inWindow && this.isActive) {
        logger.info('Exited runtime window - timeout reached');
        this.isActive = false;
      }
    };
    
    // Check immediately
    await checkWindow();
    
    // Set up interval to check every minute
    const interval = setInterval(checkWindow, 60000);
    
    // Return function to stop monitoring
    return () => {
      clearInterval(interval);
      this.isActive = false;
      logger.info('Time window monitoring stopped');
    };
  }

  async executeInWindow(callback, timeoutMs = null) {
    if (!this.isInWindow()) {
      logger.warn('Not within runtime window');
      return false;
    }
    
    const timeUntilEnd = this.getTimeUntilWindowEnds();
    const actualTimeout = timeoutMs ? Math.min(timeoutMs, timeUntilEnd) : timeUntilEnd;
    
    if (actualTimeout <= 0) {
      logger.warn('Runtime window has already ended');
      return false;
    }
    
    logger.info(`Executing within window (timeout: ${this.formatDuration(actualTimeout)})`);
    
    return new Promise(async (resolve) => {
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn('Execution timed out - window ended');
          resolve(false);
        }
      }, actualTimeout);
      
      try {
        const result = await callback();
        
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(result);
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          logger.error(`Execution failed: ${error.message}`);
          resolve(false);
        }
      }
    });
  }

  getStatus() {
    const now = this.getCurrentTime();
    const inWindow = this.isInWindow();
    const timeUntil = this.getTimeUntilWindow();
    const timeUntilEnd = this.getTimeUntilWindowEnds();
    
    return {
      currentTime: now.format('HH:mm:ss'),
      timeoutMinutes: this.timeoutMinutes,
      startTime: this.startTime.format('HH:mm'),
      endTime: this.endTime.format('HH:mm'),
      inWindow: inWindow,
      timeUntilWindow: this.formatDuration(timeUntil),
      timeUntilWindowEnds: this.formatDuration(timeUntilEnd),
      isActive: this.isActive
    };
  }

  logStatus() {
    const status = this.getStatus();
    
    logger.info(`Time Window Status:`);
    logger.info(`  Current Time: ${status.currentTime}`);
    logger.info(`  Timeout Duration: ${status.timeoutMinutes} minutes`);
    logger.info(`  Window: ${status.startTime} - ${status.endTime}`);
    logger.info(`  In Window: ${status.inWindow ? 'YES' : 'NO'}`);
    logger.info(`  Time Until Window: ${status.timeUntilWindow}`);
    logger.info(`  Time Until Window Ends: ${status.timeUntilWindowEnds}`);
    logger.info(`  Active: ${status.isActive ? 'YES' : 'NO'}`);
  }

  async enforceWindow(callback) {
    logger.info('Enforcing runtime window...');
    
    if (!this.isInWindow()) {
      await this.waitForWindow();
    }
    
    if (!this.isInWindow()) {
      logger.error('Failed to enter runtime window');
      return false;
    }
    
    return await this.executeInWindow(callback);
  }

  createWindowChecker() {
    return {
      isInWindow: () => this.isInWindow(),
      getTimeRemaining: () => this.getTimeUntilWindowEnds(),
      getStatus: () => this.getStatus(),
      formatDuration: (ms) => this.formatDuration(ms)
    };
  }
}

module.exports = TimeWindowManager;
