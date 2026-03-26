/**
 * merchandiseCheckoutFlow.js
 *
 * TEST-ONLY helper flow for validating checkout/payment selectors
 * using merchandise as a proxy until tickets go live.
 *
 * When tickets are available, the main flow follows screen_flow.md
 * steps 4-8 (match → stand → seat → retry → cart) then step 9 (checkout).
 * This file is NOT part of the production ticket flow.
 */

const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');
const CheckoutFlow = require('./checkoutFlow');

const logger = createModuleLogger('MerchandiseTestFlow');

class MerchandiseCheckoutFlow {
  constructor({ browserManager, account, telegram }) {
    this.browser = browserManager;
    this.account = account || browserManager.account || {};
    this.checkoutFlow = new CheckoutFlow({ browserManager, account });
    this.telegram = telegram;
  }

  get accountLabel() {
    return this.account.id || 'default';
  }

  async runTestFlow() {
    logger.info(`Starting merchandise test flow for account ${this.accountLabel}`);

    await this.navigateToMerchandise();
    await this.selectProduct();
    await this.selectSizeAndAddToBag();
    await this.goToBag();

    logger.info('Merchandise added to bag. Handing off to shared checkout flow...');
    return await this.checkoutFlow.runFromCurrentPage();
  }

  async executeCheckout() {
    try {
      const result = await this.runTestFlow();
      return result === 'success' || result === 'timeout' || result === true;
    } catch (error) {
      logger.error(`Merchandise checkout flow failed: ${error.message}`);
      if (this.telegram) {
        await this.telegram.sendMessage(`🛍️ Merchandise checkout flow error: ${error.message}`);
      }
      throw error;
    }
  }

  async navigateToMerchandise() {
    const currentUrl = this.browser.page.url();
    if (currentUrl.includes('/merchandise')) {
      logger.info('Already on merchandise page');
      return;
    }

    const merchButton = await this.browser.waitForAnyVisible([
      'button:has-text("MERCHANDISE")',
      'a:has-text("MERCHANDISE")',
      'text=MERCHANDISE'
    ], 5000, 200);

    if (merchButton) {
      await merchButton.click();
      await this.browser.waitForPageReady(3000);
    } else {
      await this.browser.page.goto(`${config.website.url}/merchandise`, {
        waitUntil: 'domcontentloaded',
        timeout: config.website.navigationTimeout
      });
      await this.browser.waitForPageReady(3000);
    }

    logger.info('Navigated to merchandise page');
  }

  async selectProduct() {
    const productSelector = await this.browser.waitForAnyVisible([
      'p:has-text("RCB 2026 Royalcat Comfort Slides")',
      'text=RCB 2026 Royalcat Comfort Slides',
      'div:has-text("Royalcat Comfort Slides")'
    ], 8000, 300);

    if (!productSelector) {
      throw new Error('Product "RCB 2026 Royalcat Comfort Slides" not found on merchandise page');
    }

    await productSelector.click();
    await this.browser.waitForPageReady(3000);

    const onProductPage = this.browser.page.url().includes('/merchandise/');
    if (!onProductPage) {
      throw new Error('Did not navigate to product detail page after clicking product');
    }

    logger.info('Navigated to product detail page');
    await this.browser.takeScreenshot(`merch-product-page-${this.accountLabel}.png`);
  }

  async selectSizeAndAddToBag() {
    await this.browser.page.waitForTimeout(1000);

    const preferredSize = '8';
    let sizeSelected = false;

    const preferredSizeBtn = await this.browser.firstVisible([
      `button.chakra-button:text-is("${preferredSize}")`,
      `button:text-is("${preferredSize}")`
    ]);

    if (preferredSizeBtn) {
      await preferredSizeBtn.click();
      sizeSelected = true;
      logger.info(`Selected preferred size: ${preferredSize}`);
    }

    if (!sizeSelected) {
      for (let size = 3; size <= 11; size++) {
        const sizeBtn = await this.browser.firstVisible([
          `button.chakra-button:text-is("${size}")`,
          `button:text-is("${size}")`
        ]);
        if (sizeBtn) {
          const isDisabled = await sizeBtn.isDisabled().catch(() => false);
          if (!isDisabled) {
            await sizeBtn.click();
            sizeSelected = true;
            logger.info(`Selected fallback size: ${size}`);
            break;
          }
        }
      }
    }

    if (!sizeSelected) {
      throw new Error('No available size button found on product page');
    }

    await this.browser.page.waitForTimeout(500);

    const addToBag = await this.browser.waitForAnyVisible([
      'button:has-text("ADD TO BAG")',
      'button:has-text("Add to Bag")',
      'button:has-text("ADD TO CART")'
    ], 5000, 200);

    if (!addToBag) {
      throw new Error('ADD TO BAG button not found');
    }

    await addToBag.click();
    logger.info('Clicked ADD TO BAG');

    const goToBagAppeared = await this.browser.waitForAnyVisible([
      'button:has-text("GO TO BAG")',
      'button:has-text("Go to Bag")'
    ], 5000, 300);

    if (!goToBagAppeared) {
      const currentUrl = this.browser.page.url();
      if (currentUrl.includes('/auth') || currentUrl.includes('/login')) {
        throw new Error('ADD TO BAG redirected to login — session may have expired');
      }
      throw new Error('GO TO BAG did not appear after ADD TO BAG click');
    }

    logger.info('ADD TO BAG succeeded — GO TO BAG button appeared');
    await this.browser.takeScreenshot(`merch-added-to-bag-${this.accountLabel}.png`);
  }

  async goToBag() {
    const goToBag = await this.browser.waitForAnyVisible([
      'button:has-text("GO TO BAG")',
      'button:has-text("Go to Bag")'
    ], 3000, 200);

    if (!goToBag) {
      throw new Error('GO TO BAG button not found');
    }

    await goToBag.click();
    await this.browser.waitForPageReady(3000);

    const currentUrl = this.browser.page.url();
    if (!currentUrl.includes('/checkout')) {
      throw new Error(`Expected /checkout but got ${currentUrl}`);
    }

    logger.info('Navigated to checkout page');
    await this.browser.takeScreenshot(`merch-checkout-${this.accountLabel}.png`);
  }
}

module.exports = MerchandiseCheckoutFlow;