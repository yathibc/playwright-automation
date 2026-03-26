const { createModuleLogger } = require('../utils/logger');
const TelegramNotifier = require('../notifications/telegram');
const config = require('../config/config');

const logger = createModuleLogger('CheckoutFlow');
const telegram = new TelegramNotifier();

class CheckoutFlow {
  constructor({ browserManager, account }) {
    this.browser = browserManager;
    this.account = account || browserManager.account || {};
    this.telegram = telegram;
  }

  get accountLabel() {
    return this.account.id || 'default';
  }

  async runFromCurrentPage() {
    await this.handleAddonSelection();
    await this.ensureCheckoutPage();
    await this.fillCheckoutDetails();
    await this.openPaymentGateway();
    await this.handlePaymentSelection();
    return await this.waitForManualPaymentCompletion();
  }

  /**
   * Handle the addon selection modal (metro/parking) that appears after add-to-cart success.
   * From index.js: (s.addon == "Y") ? I.onOpen() : T("/checkout")
   * If addon modal appears: select "Free Metro Ticket", skip parking, click Continue.
   * If no addon modal: app auto-navigates to /checkout — do nothing.
   */
  async handleAddonSelection() {
    logger.info(`Checking for addon selection modal for ${this.accountLabel}...`);

    // Wait briefly for addon modal OR checkout page — whichever comes first
    const addonOrCheckout = await Promise.race([
      this._waitForAddonModal(),
      this._waitForCheckoutUrl()
    ]);

    if (addonOrCheckout === 'checkout') {
      logger.info('No addon modal — already on checkout page');
      return;
    }

    if (addonOrCheckout === 'addon') {
      logger.info('Addon modal detected — selecting Free Metro Ticket');

      // Click "Free Metro Ticket" radio/option
      const metroOption = await this.browser.waitForAnyVisible([
        "text=Free Metro Ticket",
        "label:has-text('Free Metro Ticket')",
        "input[value*='metro' i]",
        "div:has-text('Free Metro Ticket')",
        "[class*='radio']:has-text('Metro')",
        "text=Metro"
      ], 3000, 200);

      if (metroOption) {
        await metroOption.click();
        logger.info('Selected Free Metro Ticket addon');
      } else {
        logger.warn('Free Metro Ticket option not found in addon modal');
      }

      // Do NOT select paid parking — skip it

      // Click Continue button in addon modal
      const continueBtn = await this.browser.waitForAnyVisible([
        "button:has-text('Continue')",
        "button:has-text('Proceed')",
        "button:has-text('Skip')"
      ], 3000, 200);

      if (continueBtn) {
        await continueBtn.click();
        logger.info('Clicked Continue on addon modal');
      }

      // Wait for navigation to checkout
      try {
        await this.browser.page.waitForURL(/checkout/i, { timeout: 10000 });
      } catch (_) {
        logger.warn('Did not navigate to checkout after addon selection');
      }
    }

    await this.browser.takeScreenshot(`addon-handled-${this.accountLabel}.png`);
  }

  async _waitForAddonModal() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const modal = await this.browser.firstVisible([
        "text=Free Metro Ticket",
        "text=Paid Parking",
        "text=Metro",
        "[class*='addon']",
        "[class*='modal']:has-text('Metro')"
      ]);
      if (modal) return 'addon';
      await this.browser.page.waitForTimeout(200);
    }
    return null;
  }

  async _waitForCheckoutUrl() {
    try {
      await this.browser.page.waitForURL(/checkout/i, { timeout: 5000 });
      return 'checkout';
    } catch (_) {
      return null;
    }
  }

  async ensureCheckoutPage() {
    const checkoutHeading = await this.browser.waitForAnyVisible([
      'text=Checkout',
      '[role="heading"]:has-text("Checkout")',
      'text=My Shopping Bag',
      'text=Total Amount'
    ], 5000, 200);

    if (!checkoutHeading) {
      throw new Error('Checkout page not detected after cart/seat confirmation');
    }
  }

  async fillCheckoutDetails() {
    await this.fillIfEmpty('textbox', 'First name', config.checkout.firstName);
    await this.fillIfEmpty('textbox', 'Last name', config.checkout.lastName);
    await this.fillIfEmpty('textbox', 'Email', this.account.email);
    await this.fillOptionalGender();
    await this.fillShippingAddress();
    await this.browser.page.waitForTimeout(750);
    await this.browser.takeScreenshot(`checkout-filled-${this.accountLabel}.png`);
  }

  async fillIfEmpty(role, name, value) {
    try {
      const locator = this.browser.page.getByRole(role, { name, exact: true }).first();
      if (!(await locator.isVisible())) return;

      const currentValue = ((await locator.inputValue().catch(() => '')) || '').trim();
      if (!currentValue) {
        await locator.fill(value);
      }
    } catch (_) {}
  }

  async fillIfVisible(role, name, value) {
    try {
      const locator = this.browser.page.getByRole(role, { name, exact: true });
      if (await locator.first().isVisible()) {
        await locator.first().fill(value);
      }
    } catch (_) {}
  }

  async fillOptionalGender() {
    const candidates = [
      `label:has-text("${config.checkout.gender}")`,
      `button:has-text("${config.checkout.gender}")`,
      `text=${config.checkout.gender}`
    ];

    for (const selector of candidates) {
      try {
        const locator = this.browser.page.locator(selector).first();
        if (await locator.isVisible()) {
          await locator.click();
          return true;
        }
      } catch (_) {}
    }

    try {
      const select = this.browser.page.locator('select').first();
      if (await select.isVisible()) {
        await select.selectOption({ label: config.checkout.gender });
        return true;
      }
    } catch (_) {}

    logger.info('Gender field not visibly exposed on checkout; continuing without forcing it');
    return false;
  }

  async fillShippingAddress() {
    // Use direct name-attribute selectors confirmed from live UI inspection
    await this.fillByNameAttr('addLine1', config.checkout.address);
    await this.fillByNameAttr('addLine2', config.checkout.locality);
    await this.fillByNameAttr('pinCode', config.checkout.pincode);

    // Wait for city/state auto-population after pincode
    await this.browser.page.waitForTimeout(1500);

    const cityValue = await this.getFieldValueByName('city');
    const stateValue = await this.getFieldValueByName('state');
    logger.info(`Checkout address state after pincode fill for
    ${this.accountLabel}: city='${cityValue || ''}', state='${stateValue || ''}'`);
  }

  async fillByNameAttr(name, value) {
    if (!value) return false;

    try {
      // Primary: use input[name="..."] which is stable across renders
      const field = this.browser.page.locator(`input[name="${name}"]`).first();
      await field.waitFor({ state: 'visible', timeout: 3000 });
      await field.fill('');
      await field.fill(value);
      return true;
    } catch (_) {
      // Fallback: try getByRole with accessible name
      return await this.fillTextboxDirect(name, value);
    }
  }

  async fillTextboxDirect(name, value) {
    if (!value) return false;

    try {
      const field = this.browser.page.getByRole('textbox', { name, exact: true }).first();
      await field.waitFor({ state: 'visible', timeout: 3000 });
      await field.fill('');
      await field.fill(value);
      return true;
    } catch (_) {
      return false;
    }
  }

  async getFieldValueByName(name) {
    try {
      const field = this.browser.page.locator(`input[name="${name}"]`).first();
      if (!(await field.isVisible())) return '';
      return ((await field.inputValue().catch(() => '')) || '').trim();
    } catch (_) {
      return '';
    }
  }

  async getTextboxValue(name) {
    try {
      const field = this.browser.page.getByRole('textbox', { name, exact: true }).first();
      if (!(await field.isVisible())) return '';
      return ((await field.inputValue().catch(() => '')) || '').trim();
    } catch (_) {
      return '';
    }
  }

  async openPaymentGateway() {
    try {
      const checkbox = this.browser.page.getByRole('checkbox', { name: /I accept/i });
      if (await checkbox.first().isVisible() && !(await checkbox.first().isChecked())) {
        await checkbox.first().check();
      }
    } catch (_) {}

    const payNow = await this.browser.waitForAnyVisible([
      "button:has-text('PAY NOW')",
      "button:has-text('Pay Now')"
    ], 5000, 200);

    if (!payNow) {
      throw new Error('PAY NOW button not found on checkout page');
    }

    await payNow.click();
    await this.browser.page.waitForURL(/juspay|payment/i,
        { timeout: config.website.navigationTimeout }).catch(() => {});

    // Wait for the Juspay payment page to fully load (it renders inside iframes)
    await this.browser.page.waitForTimeout(3000);

    // Locate the Juspay payment iframe and get its content frame
    this.paymentFrame = await this._getJuspayPaymentFrame();

    await this.browser.takeScreenshot(`payment-gateway-${this.accountLabel}.png`);
  }

  /**
   * Locate the Juspay payment iframe (in.juspay.hyperpay) and return its content frame.
   * The payment UI (Cards, UPI tabs, inputs) lives inside this iframe.
   */
  async _getJuspayPaymentFrame() {
    const page = this.browser.page;

    // Try to find the Juspay hyperpay iframe
    const iframeSelectors = [
      'iframe#in\\.juspay\\.hyperpay',
      'iframe[id="in.juspay.hyperpay"]',
      'iframe.juspay-mapp-iframe'
    ];

    for (const sel of iframeSelectors) {
      try {
        const iframeEl = page.locator(sel).first();
        if (await iframeEl.isVisible({ timeout: 3000 }).catch(() => false)) {
          const frame = page.frame({ url: /juspay|hyperpay/i }) || iframeEl.contentFrame();
          if (frame) {
            // Wait for frame content to be ready
            const resolvedFrame = await frame;
            await resolvedFrame.waitForLoadState('domcontentloaded').catch(() => {});
            logger.info('Found Juspay payment iframe');
            return resolvedFrame;
          }
        }
      } catch (_) {}
    }

    // Fallback: try to find any frame that contains payment elements
    for (const frame of page.frames()) {
      try {
        const hasPaymentContent = await frame.locator('text=UPI').first().isVisible({ timeout: 1000 })
                .catch(() => false)
          || await frame.locator('text=Cards').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (hasPaymentContent) {
          logger.info('Found payment content in a frame (fallback)');
          return frame;
        }
      } catch (_) {}
    }

    logger.warn('No Juspay iframe found — payment elements may be in the main page');
    return null;
  }

  /**
   * Get the frame/page context where payment elements live.
   * Returns the Juspay iframe frame if found, otherwise the main page.
   */
  _getPaymentContext() {
    return this.paymentFrame || this.browser.page;
  }

  /**
   * Wait for any of the given selectors to become visible in the payment context (iframe or main page).
   */
  async _waitForPaymentVisible(selectors, timeout = 5000, interval = 200) {
    const ctx = this._getPaymentContext();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        try {
          const matches = ctx.locator(selector);
          const count = await matches.count().catch(() => 0);
          for (let i = 0; i < count; i += 1) {
            const el = matches.nth(i);
            if (await el.isVisible().catch(() => false)) return el;
          }
        } catch (_) {}
      }
      await this.browser.page.waitForTimeout(interval);
    }
    return null;
  }

  async _countVisibleInPaymentContext(selector) {
    const ctx = this._getPaymentContext();
    const matches = ctx.locator(selector);
    const total = await matches.count().catch(() => 0);
    let visible = 0;

    for (let i = 0; i < total; i += 1) {
      if (await matches.nth(i).isVisible().catch(() => false)) visible += 1;
    }

    return { total, visible };
  }

  async _verifyUpiSectionActivated() {
    const activated = await this._waitForPaymentVisible([
      '[testid="active_screen"] [testid="nvb_upi"]',
      '[testid="active_screen"] [testid="nvb_icon_upi"]',
      '[testid="active_screen"] [testid="edt_upi"]',
      '[testid="active_screen"] input[testid*="upi"]',
      '[testid="active_screen"] input[placeholder*="UPI"]',
      '[testid="active_screen"] input[placeholder*="upi"]',
      'input[testid="edt_upi"]',
      'input[placeholder*="UPI"]'
    ], 5000, 200);

    if (!activated) {
      logger.warn('UPI tab click did not expose an active UPI section yet; proceeding with generic UPI input lookup');
      return false;
    }

    return true;
  }

  async handlePaymentSelection() {
    const paymentType = String(this.account.paymentType || 'UPI').toUpperCase();
    logger.info(`Handling payment branch ${paymentType} for account ${this.account.id || 'default'}`);

    if (paymentType === 'CARD') {
      await this.handleCardPayment();
      return;
    }

    await this.handleUpiPayment();
  }

  async handleUpiPayment() {
    const upiStats = await this._countVisibleInPaymentContext(
        '[testid="nvb_upi"], [testid="nvb_icon_upi"],' +
        '[data-testid="nvb_upi"], [data-testid="nvb_icon_upi"]');
    logger.info(`UPI tab candidates in payment context: total=${upiStats.total}, visible=${upiStats.visible}`);

    // Click the UPI tab in the Juspay payment sidebar (inside iframe)
    const upiTab = await this.findPaymentMethodTab('UPI', { preferActiveScreen: true });
    if (upiTab) {
      await upiTab.click().catch(() => {});
      logger.info('Clicked UPI tab, waiting for UPI section to load...');
      await this._verifyUpiSectionActivated();
    } else {
      logger.warn('UPI tab not found — UPI section may already be active or page layout differs');
    }

    await this.browser.takeScreenshot(`upi-tab-clicked-${this.accountLabel}.png`);

    // Wait for UPI input field inside the payment context (iframe)
    const upiInput = await this._waitForPaymentVisible([
      'input[placeholder*="UPI"]',
      'input[placeholder*="upi"]',
      'input[placeholder*="@"]',
      'input[placeholder*="Username@bankname"]',
      'input[placeholder*="example@upi"]',
      'input[placeholder*="VPA"]',
      "input[testid='edt_upi']",
      "input[testid*='upi']",
      '[testid*="upi"] input',
      '[testid*="vpa"] input'
    ], 10000, 300);
    if (!upiInput) {
      throw new Error('UPI input not available on payment page');
    }

    await upiInput.fill(config.payment.upiId);
    logger.info(`Filled UPI ID for ${this.accountLabel}`);

    const verifyPay = await this._waitForPaymentVisible([
      "text=VERIFY AND PAY",
      "button:has-text('VERIFY AND PAY')",
      "button:has-text('Verify and Pay')",
      "text=COLLECT USING UPI ID",
      "button:has-text('PAY NOW')"
    ], 8000, 200);
    if (!verifyPay) {
      throw new Error('VERIFY AND PAY control not found for UPI flow');
    }

    await verifyPay.click();
    logger.info(`💳 UPI payment initiated for ${this.accountLabel} using configured UPI ID. Complete approval manually.`);
    await this.telegram.sendMessage(`💳 *UPI Payment Initiated*\n\nAccount: ${this.accountLabel}\nUPI ID: ${config.payment.upiId}\nApprove payment on your UPI app.`);
  }

  async handleCardPayment() {
    const cardsTab = await this.findPaymentMethodTab('Cards');
    if (cardsTab) await cardsTab.click().catch(() => {});

    // Juspay card fields: "Card number" (or "Enter Card Number"), "Expiry" (or "MM/YY"), "CVV"
    const cardInput = await this.browser.waitForAnyVisible([
      'input[placeholder*="Card number"]',
      'input[placeholder*="Enter Card Number"]',
      'input[placeholder*="Card Number"]',
      "textbox[name='Card number']",
      "textbox[name='Enter Card Number']"
    ], 5000, 150);
    if (!cardInput) {
      throw new Error('Card number input not available on payment page');
    }

    await cardInput.fill(config.payment.cardNumber);
    await this.fillFieldByRoleName('Expiry', config.payment.expiryDate);
    await this.fillFieldByRoleName('MM/YY', config.payment.expiryDate);
    await this.fillFieldByRoleName('CVV', config.payment.cvv);

    const payNow = await this.browser.waitForAnyVisible([
      "role=button[name='PAY NOW']",
      'text=PAY NOW',
      "button:has-text('PAY NOW')",
      "button:has-text('Pay Now')"
    ], 5000, 150);
    if (!payNow) {
      throw new Error('PAY NOW control not found for card payment flow');
    }

    await payNow.click();
    logger.info(`💳 Card payment initiated for ${this.accountLabel}. Complete 3DS/OTP manually within ${config.checkout.cardOtpWaitMinutes} minutes.`);
    await this.telegram.sendMessage(`💳 *Card Payment Initiated*\n\nAccount: ${this.accountLabel}\nComplete 3DS/OTP within ${config.checkout.cardOtpWaitMinutes} minutes.`);
  }

  async fillFieldByRoleName(name, value) {
    try {
      const locator = this.browser.page.getByRole('textbox', { name, exact: true }).first();
      if (await locator.isVisible()) {
        await locator.fill(value);
        return true;
      }
    } catch (_) {}

    try {
      const locator = this.browser.page.locator(`input[placeholder*="${name}"]`).first();
      if (await locator.isVisible()) {
        await locator.fill(value);
        return true;
      }
    } catch (_) {}

    return false;
  }

  async findPaymentMethodTab(label, options = {}) {
    const { preferActiveScreen = false } = options;

    // Map payment method labels to Juspay testid attributes from the sidebar
    const testIdMap = {
      'UPI': ['nvb_upi', 'nvb_icon_upi'],
      'Cards': ['nvb_card'],
      'Netbanking': ['nvb_net_banking'],
      'Wallets': ['nvb_wallet']
    };

    const testIds = testIdMap[label] || [];

    // For UPI, prioritize the active screen subtree to avoid clicking hidden/idle duplicates.
    if (label === 'UPI' && preferActiveScreen) {
      const activeUpiTab = await this._waitForPaymentVisible([
        '[testid="active_screen"] [testid="nvb_upi"]',
        '[testid="active_screen"] [testid="nvb_icon_upi"]',
        '[testid="active_screen"] [data-testid="nvb_upi"]',
        '[testid="active_screen"] [data-testid="nvb_icon_upi"]',
        '[testid="active_screen"] :text("UPI")'
      ], 5000, 150);

      if (activeUpiTab) {
        logger.info("Found payment tab 'UPI' inside active_screen");
        return activeUpiTab;
      }
    }

    // Priority 1: Search inside the payment iframe using testid (most reliable)
    if (testIds.length) {
      for (const testId of testIds) {
        const selectors = [
          `[testid="${testId}"]`,
          `[testID="${testId}"]`,
          `[data-testid="${testId}"]`
        ];

        if (label === 'UPI') {
          selectors.unshift(
            `[testid="active_screen"] [testid="${testId}"]`,
            `[testid="active_screen"] [testID="${testId}"]`,
            `[testid="active_screen"] [data-testid="${testId}"]`
          );
        }

        const byTestId = await this._waitForPaymentVisible(selectors, 5000, 150);
        if (byTestId) {
          logger.info(`Found payment tab '${label}' via testid='${testId}' in payment frame`);
          return byTestId;
        }
      }
    }

    // Priority 2: Search inside payment iframe by text
    const textSelectors = [
      `text=${label}`,
      `div.textView:has-text("${label}")`
    ];
    if (label === 'UPI') {
      textSelectors.unshift('[testid="active_screen"] :text("UPI")');
    }

    const byText = await this._waitForPaymentVisible(textSelectors, 5000, 150);
    if (byText) {
      logger.info(`Found payment tab '${label}' via text match in payment frame`);
      return byText;
    }

    // Priority 3: Fallback to main page search
    const exactRoleMatch = this.browser.page.getByText(label, { exact: true }).first();
    try {
      if (await exactRoleMatch.isVisible()) {
        logger.info(`Found payment tab '${label}' via exact text match in main page`);
        return exactRoleMatch;
      }
    } catch (_) {}

    const found = await this.browser.waitForAnyVisible([
      `text=${label}`,
      `[role="tab"]:has-text("${label}")`,
      `div:has-text("${label}")`
    ], 5000, 150);

    if (found) {
      logger.info(`Found payment tab '${label}' via fallback selector in main page`);
    } else {
      logger.warn(`Payment tab '${label}' not found in iframe or main page`);
    }
    return found;
  }

  /**
   * Poll the browser URL and body text to detect whether payment succeeded, failed, or timed out.
   *
   * Generic: works for both merchandise and ticket booking flows.
   * Uses config.website.url to derive the merchant hostname — nothing is hardcoded.
   *
   * @returns {'success' | 'failed' | 'timeout'} — the payment outcome
   */
  async waitForManualPaymentCompletion() {
    const paymentType = String(this.account.paymentType || 'UPI').toUpperCase();
    const waitMinutes = paymentType === 'CARD'
      ? config.checkout.cardOtpWaitMinutes
      : config.checkout.paymentWaitMinutes;
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

    // URL path keywords that indicate SUCCESS (returned to merchant with a success path)
    const successUrlKeywords = ['success', 'confirm', 'thankyou', 'thank-you', 'complete', 'verified'];

    // URL path keywords that indicate FAILURE (returned to merchant with a failure path)
    const failureUrlKeywords = ['failed', 'failure', 'cancel', 'cancelled', 'declined', 'error', 'timeout', 'expired'];

    // Body text phrases that indicate SUCCESS
    const successBodyPhrases = [
      'payment successful',
      'transaction successful',
      'booking confirmed',
      'order confirmed',
      'order placed',
      'ticket confirmed',
      'tickets booked',
      'purchase complete',
      'thank you for your purchase',
      'your booking is confirmed'
    ];

    // Body text phrases that indicate FAILURE
    const failureBodyPhrases = [
      'payment failed',
      'transaction failed',
      'payment declined',
      'payment cancelled',
      'order failed',
      'booking failed',
      'transaction declined',
      'payment was not successful',
      'payment unsuccessful',
      'could not process your payment'
    ];

    logger.info(`⏳ Waiting up to ${waitMinutes} minutes for payment outcome (${paymentType}) for ${this.accountLabel}...`);

    while (Date.now() - started < waitMs) {
      try {
        const url = this.browser.page.url().toLowerCase();
        const onPaymentGateway = paymentGatewayPatterns.some(gw => url.includes(gw));
        const onMerchantSite = !merchantHost || url.includes(merchantHost);

        // Only check for outcomes when we've left the payment gateway
        if (!onPaymentGateway && onMerchantSite) {
          // Check URL for success
          const matchedSuccessUrl = successUrlKeywords.find(kw => url.includes(kw));
          if (matchedSuccessUrl) {
            await this.browser.takeScreenshot(`payment-success-${this.accountLabel}.png`);
            logger.info(`✅ Payment SUCCESS for ${this.accountLabel} — URL matched '${matchedSuccessUrl}': ${url}`);
            await this.telegram.sendMessage(`✅ *Payment Successful!*\n\nAccount: ${this.accountLabel}\nBooking confirmed!`);
            return 'success';
          }

          // Check URL for failure
          const matchedFailureUrl = failureUrlKeywords.find(kw => url.includes(kw));
          if (matchedFailureUrl) {
            await this.browser.takeScreenshot(`payment-failed-${this.accountLabel}.png`);
            logger.error(`❌ Payment FAILED for ${this.accountLabel} — URL matched '${matchedFailureUrl}': ${url}`);
            await this.telegram.sendMessage(`❌ *Payment Failed*\n\nAccount: ${this.accountLabel}\nReason: URL matched '${matchedFailureUrl}'`);
            return 'failed';
          }
        }

        // Check body text for success/failure phrases (only when not on payment gateway)
        if (!onPaymentGateway) {
          const bodyText = ((await this.browser.page.locator('body').textContent()
              .catch(() => '')) || '').toLowerCase();

          const matchedSuccess = successBodyPhrases.find(phrase => bodyText.includes(phrase));
          if (matchedSuccess) {
            await this.browser.takeScreenshot(`payment-success-${this.accountLabel}.png`);
            logger.info(`✅ Payment SUCCESS for ${this.accountLabel} — body text: "${matchedSuccess}"`);
            await this.telegram.sendMessage(`✅ *Payment Successful!*\n\nAccount: ${this.accountLabel}\nBooking confirmed!`);
            return 'success';
          }

          const matchedFailure = failureBodyPhrases.find(phrase => bodyText.includes(phrase));
          if (matchedFailure) {
            await this.browser.takeScreenshot(`payment-failed-${this.accountLabel}.png`);
            logger.error(`❌ Payment FAILED for ${this.accountLabel} — body text: "${matchedFailure}"`);
            await this.telegram.sendMessage(`❌ *Payment Failed*\n\nAccount: ${this.accountLabel}\nReason: "${matchedFailure}"`);
            return 'failed';
          }
        }
      } catch (_) {
        // Page may have navigated / crashed — continue polling
      }

      await this.browser.page.waitForTimeout(3000);
    }

    await this.browser.takeScreenshot(`payment-timeout-${this.accountLabel}.png`);
    logger.warn(`⏰ Payment outcome not detected within ${waitMinutes} minutes for ${this.accountLabel}. Neither success nor failure was confirmed.`);
    await this.telegram.sendMessage(`⏰ *Payment Timeout*\n\nAccount: ${this.accountLabel}\nNo payment outcome detected within ${waitMinutes} minutes.\nBrowser left open for manual completion.`);
    return 'timeout';
  }
}

module.exports = CheckoutFlow;