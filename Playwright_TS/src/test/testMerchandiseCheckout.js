const { createModuleLogger } = require('../utils/logger');
const BrowserManager = require('../browser/browser');
const LoginManager = require('../auth/login');
const MerchandiseCheckoutFlow = require('../flows/merchandiseCheckoutFlow');
const TelegramNotifier = require('../notifications/telegram');
const config = require('../config/config');

const logger = createModuleLogger('MerchTest');

async function testMerchandiseCheckout() {
  logger.info('🛍️ Starting Merchandise Checkout Test');
  
  const browserManager = new BrowserManager(999, { id: 'test-merch', phone: config.website.loginPhone });
  const telegramNotifier = new TelegramNotifier();
  const loginManager = new LoginManager(browserManager, telegramNotifier);
  const merchCheckout = new MerchandiseCheckoutFlow(browserManager, telegramNotifier);
  
  try {
    // Initialize browser
    const browserInitialized = await browserManager.initialize();
    if (!browserInitialized) {
      logger.error('❌ Failed to initialize browser');
      return false;
    }

    // Start network capture
    await browserManager.startNetworkCapture();

    // Navigate to website
    const navigated = await browserManager.navigateToWebsite();
    if (!navigated) {
      logger.error('❌ Failed to navigate to website');
      return false;
    }

    // Handle login
    const loginSuccess = await loginManager.detectAndHandleLogin();
    if (!loginSuccess) {
      logger.error('❌ Login failed');
      return false;
    }

    logger.info('✅ Login successful, proceeding with merchandise checkout');

    // Execute merchandise checkout
    const checkoutSuccess = await merchCheckout.executeCheckout();
    if (checkoutSuccess) {
      logger.info('🎉 Merchandise checkout test completed successfully');
      await telegram.sendMessage('🛍️ ✅ *Merchandise Checkout Test Completed*\n\nTest passed successfully!');
    } else {
      logger.error('❌ Merchandise checkout test failed');
      await telegram.sendMessage('🛍️ ❌ *Merchandise Checkout Test Failed*\n\nTest failed. Check logs for details.');
    }

    // Take final screenshot
    await browserManager.takeScreenshot('merch-checkout-final.png');

    return checkoutSuccess;

  } catch (error) {
    logger.error(`❌ Merchandise checkout test error: ${error.message}`);
    await telegram.sendMessage(`🛍️ 💥 *Merchandise Checkout Test Error*\n\n${error.message}`);
    return false;
  } finally {
    // Cleanup
    try {
      await browserManager.stopNetworkCapture();
      await browserManager.close();
      logger.info('🧹 Browser cleanup completed');
    } catch (cleanupError) {
      logger.error(`Error during cleanup: ${cleanupError.message}`);
    }
  }
}

// Run the test
if (require.main === module) {
  testMerchandiseCheckout()
    .then(success => {
      logger.info(`Merchandise checkout test ${success ? 'PASSED' : 'FAILED'}`);
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      logger.error(`Merchandise checkout test crashed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = testMerchandiseCheckout;
