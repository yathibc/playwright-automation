const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'HH:mm:ss'
    }),
    winston.format.printf(({ timestamp, level, message, module }) => {
      const moduleStr = module ? ` | ${module}` : '';
      return `${timestamp} | ${level.toUpperCase()}${moduleStr} | ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(logDir, 'automation.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

const createModuleLogger = (moduleName) => {
  return {
    info: (message) => logger.info(message, { module: moduleName }),
    error: (message) => logger.error(message, { module: moduleName }),
    warn: (message) => logger.warn(message, { module: moduleName }),
    debug: (message) => logger.debug(message, { module: moduleName })
  };
};

module.exports = { logger, createModuleLogger };