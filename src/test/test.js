const TicketAutomationSystem = require('../index');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('Test');

async function runTests() {
  logger.info('🧪 Starting Test Suite');

  try {
    // Test 1: Configuration loading
    logger.info('Test 1: Configuration loading');
    const config = require('../config/config');
    logger.info(`✅ Config loaded - Runtime: ${config.runtime.start}-${config.runtime.end}`);

    // Test 2: Time window functionality
    logger.info('Test 2: Time window functionality');
    const TimeWindowManager = require('../utils/timeWindow');
    const timeWindow = new TimeWindowManager();
    const status = timeWindow.getStatus();
    logger.info(`✅ Time window status: ${status.inWindow ? 'IN WINDOW' : 'OUTSIDE WINDOW'}`);

    // Test 3: Browser initialization (single session)
    logger.info('Test 4: Browser initialization');
    const BrowserManager = require('../browser/browser');
    const browser = new BrowserManager(999); // Test session ID
    const initialized = await browser.initialize();
    if (initialized) {
      logger.info('✅ Browser initialized successfully');
      await browser.close();
    } else {
      logger.error('❌ Browser initialization failed');
    }

    // Test 5: Module imports
    logger.info('Test 5: Module imports');
    const modules = [
      { name: 'LoginManager', path: '../auth/login' },
      { name: 'MatchDetector', path: '../detection/matchDetector' },
      { name: 'SeatMapDetector', path: '../detection/seatMapDetector' },
      { name: 'SeatSelector', path: '../selection/seatSelector' },
      { name: 'EventMonitor', path: '../monitoring/eventMonitor' },
      { name: 'ParallelSessionController', path: '../session/parallelController' },
      { name: 'DebugManager', path: '../utils/debug' }
    ];

    for (const module of modules) {
      try {
        const ModuleClass = require(module.path);
        logger.info(`✅ ${module.name} imported successfully`);
      } catch (error) {
        logger.error(`❌ Failed to import ${module.name}: ${error.message}`);
      }
    }

    logger.info('🎉 Test Suite Completed');
    logger.info('Use direct module validation / manual execution when OTP capacity is available;' +
        ' avoid running npm start if OTP is rate-limited.');

  } catch (error) {
    logger.error(`❌ Test failed: ${error.message}`);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = runTests;