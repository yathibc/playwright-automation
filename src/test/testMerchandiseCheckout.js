/**
 * testMerchandiseCheckout.js
 *
 * Standalone test runner for the merchandise checkout flow.
 * Tests the full flow: login → merchandise → product → size → ADD TO BAG → GO TO BAG → checkout → payment
 *
 * Usage: npm run test:merch
 */

require('dotenv').config();
const { createModuleLogger } = require('../utils/logger');
const BrowserManager = require('../browser/browser');
const LoginManager = require('../auth/login');
const MerchandiseCheckoutFlow = require('../flows/merchandiseCheckoutFlow');
const config = require('../config/config');

const logger = createModuleLogger('MerchTest');

async function runMerchandiseCheckoutTest() {
  const account = config.accounts[0] || {
    id: 'acc1',
    phone: config.website.loginPhone,
    enabled: true,
    standPriority: config.seats.standPriority,
    paymentType: 'CARD'
  };

  logger.info('🛍️ Starting Merchandise Checkout Test');
  logger.info(`Account: ${account.id} | Phone: ${account.phone} | Payment: ${account.paymentType}`);

  const browserManager = new BrowserManager(1, account);

  try {
    // Step 1: Initialize browser
    logger.info('Step 1: Initializing browser...');
    const initialized = await browserManager.initialize();
    if (!initialized) {
      throw new Error('Browser initialization failed');
    }
    logger.info('✅ Browser initialized');

    // Step 2: Navigate to site
    logger.info('Step 2: Navigating to site...');
    const navigated = await browserManager.navigateToWebsite();
    if (!navigated) {
      throw new Error('Website navigation failed');
    }
    logger.info('✅ Site loaded');

    // Step 3: Start network capture
    logger.info('Step 3: Starting network capture...');
    await browserManager.startNetworkCapture();
    logger.info('✅ Network capture active');

    // Step 4: Login
    logger.info('Step 4: Checking login state...');
    const loginManager = new LoginManager(browserManager, account);
    const loginSuccess = await loginManager.detectAndHandleLogin();
    if (!loginSuccess) {
      logger.error('❌ Login failed or OTP timeout. Browser left open for manual review.');
      // Keep browser open for manual intervention
      await waitForever('Login failed — browser open for manual review');
      return;
    }
    logger.info('✅ Logged in successfully');

    // Step 5: Run merchandise checkout flow
    logger.info('Step 5: Running merchandise checkout flow...');
    const merchFlow = new MerchandiseCheckoutFlow({ browserManager, account });
    const result = await merchFlow.runTestFlow();

    if (result === 'success') {
      logger.info('🎉 Payment completed successfully!');
    } else if (result === 'failed') {
      logger.error('❌ Payment failed. Check screenshots for details.');
    } else if (result === 'timeout') {
      logger.warn('⏰ Payment outcome not determined within the wait period.');
    } else {
      // Legacy boolean support (true/false from older flows)
      logger.info(result ? '🎉 Checkout flow completed.' : '⚠️ Checkout flow completed with issues.');
    }

    // Secondary wait — in case the checkout flow returned before the final redirect
    await waitForPaymentOrTimeout(browserManager, config.checkout.paymentWaitMinutes || 10);

  } catch (error) {
    logger.error(`❌ Test failed: ${error.message}`);
    logger.error(error.stack);
    await browserManager.takeScreenshot('merch-test-error.png');

    // Keep browser open for debugging
    logger.info('Browser left open for debugging. Press Ctrl+C to exit.');
    await waitForever('Test failed — browser open for debugging');
  }
}

async function waitForPaymentOrTimeout(browserManager, waitMinutes) {
  const waitMs = waitMinutes * 60 * 1000;
  const started = Date.now();

  // Derive merchant hostname from config so this works for any site
  let merchantHost = '';
  try {
    merchantHost = new URL(config.website.url).hostname.toLowerCase();
  } catch (_) {
    merchantHost = '';
  }

  // Payment gateway domains — skip detection while still on these
  const paymentGatewayPatterns = ['juspay', 'razorpay', 'paytm', 'phonepe', 'payumoney', 'ccavenue'];

  // URL path keywords that indicate SUCCESS
  const successUrlKeywords = ['success', 'confirm', 'thankyou', 'thank-you', 'complete', 'verified'];

  // URL path keywords that indicate FAILURE
  const failureUrlKeywords = ['failed', 'failure', 'cancel', 'cancelled', 'declined', 'error', 'timeout', 'expired'];

  logger.info(`⏳ Waiting up to ${waitMinutes} minutes for payment outcome...`);
  logger.info('Complete payment manually in the browser. Process will exit on outcome or timeout.');

  let outcome = 'timeout';

  while (Date.now() - started < waitMs) {
    try {
      const url = browserManager.page.url().toLowerCase();
      const onPaymentGateway = paymentGatewayPatterns.some(gw => url.includes(gw));
      const onMerchantSite = !merchantHost || url.includes(merchantHost);

      if (!onPaymentGateway && onMerchantSite) {
        // Check for success
        const matchedSuccess = successUrlKeywords.find(kw => url.includes(kw));
        if (matchedSuccess) {
          logger.info(`✅ Payment SUCCESS detected (URL: '${matchedSuccess}'). Taking final screenshot...`);
          await browserManager.takeScreenshot('test-payment-success.png');
          outcome = 'success';
          break;
        }

        // Check for failure
        const matchedFailure = failureUrlKeywords.find(kw => url.includes(kw));
        if (matchedFailure) {
          logger.error(`❌ Payment FAILED detected (URL: '${matchedFailure}'). Taking screenshot...`);
          await browserManager.takeScreenshot('test-payment-failed.png');
          outcome = 'failed';
          break;
        }
      }
    } catch (_) {}

    await browserManager.page.waitForTimeout(3000).catch(() => {});
  }

  if (outcome === 'timeout') {
    logger.warn('⏰ Payment outcome not detected within wait period. Taking screenshot...');
    await browserManager.takeScreenshot('test-payment-timeout.png').catch(() => {});
  }

  logger.info(`Test run complete (outcome: ${outcome}). Closing browser...`);
  await browserManager.close();
  process.exit(outcome === 'success' ? 0 : 1);
}

async function waitForever(reason) {
  logger.info(`${reason}. Press Ctrl+C to exit.`);
  return new Promise(() => {
    // Never resolves — keeps process alive until Ctrl+C
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT — shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM — shutting down...');
  process.exit(0);
});

// Run
runMerchandiseCheckoutTest().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
