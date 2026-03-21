const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('CheckoutFlow');

class CheckoutFlow {
  constructor({ browserManager, telegramNotifier, account }) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
    this.account = account || browserManager.account || {};
  }

  get accountLabel() {
    return this.account.id || 'default';
  }

  async runFromCurrentPage() {
    await this.ensureCheckoutPage();
    await this.fillCheckoutDetails();
    await this.openPaymentGateway();
    await this.handlePaymentSelection();
    return await this.waitForManualPaymentCompletion();
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
    await this.fillTextboxDirect('Address (House no. / Building)', config.checkout.address);
    await this.fillTextboxDirect('Locality (Area / Street)', config.checkout.locality);
    await this.fillTextboxDirect('Pincode', config.checkout.pincode);

    await this.browser.page.waitForTimeout(1200);

    const cityValue = await this.getTextboxValue('City');
    const stateValue = await this.getTextboxValue('State');
    logger.info(`Checkout address state after pincode fill for ${this.accountLabel}: city='${cityValue || ''}', state='${stateValue || ''}'`);
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
    await this.browser.page.waitForURL(/juspay|payment/i, { timeout: config.website.navigationTimeout }).catch(() => {});
    await this.browser.waitForAnyVisible([
      "textbox[name='Enter Card Number']",
      "textbox[name='Username@bankname']",
      'text=Cards',
      'text=UPI'
    ], 10000, 200);
    await this.browser.page.waitForTimeout(1200);
    await this.browser.takeScreenshot(`payment-gateway-${this.accountLabel}.png`);
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
    const upiTab = await this.findPaymentMethodTab('UPI');
    if (upiTab) await upiTab.click().catch(() => {});

    const upiInput = await this.browser.waitForAnyVisible([
      "textbox[name='Username@bankname']",
      'input[placeholder*="Username@bankname"]',
      'input[placeholder*="@"]'
    ], 5000, 150);
    if (!upiInput) {
      throw new Error('UPI input not available on payment page');
    }

    await upiInput.fill(config.payment.upiId);

    const verifyPay = await this.browser.waitForAnyVisible([
      "role=button[name='VERIFY AND PAY']",
      "text=VERIFY AND PAY",
      "button:has-text('VERIFY AND PAY')"
    ], 5000, 150);
    if (!verifyPay) {
      throw new Error('VERIFY AND PAY control not found for UPI flow');
    }

    await verifyPay.click();
    await this.telegram?.sendMessage?.(`💳 UPI payment initiated for ${this.accountLabel} using configured UPI ID. Complete approval manually.`);
  }

  async handleCardPayment() {
    const cardsTab = await this.findPaymentMethodTab('Cards');
    if (cardsTab) await cardsTab.click().catch(() => {});

    const cardInput = await this.browser.waitForAnyVisible([
      "textbox[name='Enter Card Number']",
      'input[placeholder*="Enter Card Number"]',
      'input[placeholder*="Card Number"]'
    ], 5000, 150);
    if (!cardInput) {
      throw new Error('Card number input not available on payment page');
    }

    await cardInput.fill(config.payment.cardNumber);
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
    await this.telegram?.sendMessage?.(`💳 Card payment initiated for ${this.accountLabel}. Complete 3DS/OTP manually within ${config.checkout.cardOtpWaitMinutes} minutes.`);
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

  async findPaymentMethodTab(label) {
    const exactRoleMatch = this.browser.page.getByText(label, { exact: true }).first();
    try {
      if (await exactRoleMatch.isVisible()) {
        return exactRoleMatch;
      }
    } catch (_) {}

    return await this.browser.waitForAnyVisible([
      `text=${label}`,
      `[role="tab"]:has-text("${label}")`,
      `div:has-text("${label}")`
    ], 4000, 150);
  }

  async waitForManualPaymentCompletion() {
    const paymentType = String(this.account.paymentType || 'UPI').toUpperCase();
    const waitMinutes = paymentType === 'CARD'
      ? config.checkout.cardOtpWaitMinutes
      : config.checkout.paymentWaitMinutes;
    const waitMs = waitMinutes * 60 * 1000;
    const started = Date.now();

    while (Date.now() - started < waitMs) {
      const url = this.browser.page.url().toLowerCase();
      const bodyText = ((await this.browser.page.locator('body').textContent().catch(() => '')) || '').toLowerCase();

      if (
        (url.includes('shop.royalchallengers.com') && (url.includes('order') || url.includes('success') || url.includes('mypage'))) ||
        bodyText.includes('order') ||
        bodyText.includes('payment successful') ||
        bodyText.includes('transaction successful') ||
        bodyText.includes('booking confirmed')
      ) {
        await this.browser.takeScreenshot(`payment-success-${this.accountLabel}.png`);
        await this.telegram?.sendMessage?.(`✅ Payment success indicators detected for ${this.accountLabel}. Review the open browser and close after confirmation.`);
        return true;
      }

      await this.browser.page.waitForTimeout(3000);
    }

    await this.browser.takeScreenshot(`payment-pending-${this.accountLabel}.png`);
    await this.telegram?.sendMessage?.(`⏰ Payment completion not detected within ${waitMinutes} minutes for ${this.accountLabel}. Browser remains open for manual review.`);
    return true;
  }
}

module.exports = CheckoutFlow;