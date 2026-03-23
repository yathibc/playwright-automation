const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('Auth');

class LoginManager {
  constructor(browserManager, telegramNotifier, account = null) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
    this.account = account || browserManager.account || null;
  }

  async detectPassiveAuthState() {
    try {
      const currentUrl = this.browser.page.url().toLowerCase();

      if (currentUrl.includes('/auth?callbackurl')) {
        return 'phone_required';
      }

      if (currentUrl.includes('/rcbian/mypage') || currentUrl.endsWith('/rcbian') || currentUrl.includes('/rcbian?')) {
        const myAccountHeading = await this.browser.firstVisible([
          'text=My Account',
          '[role="heading"]:has-text("My Account")',
          'button:has-text("My Orders")',
          'button:has-text("Profile")',
          'button:has-text("My Addresses")'
        ]);
        if (myAccountHeading) {
          return 'logged_in';
        }
      }

      const phoneInput = await this.browser.firstVisible([
        "input[type='tel']:not([data-index])",
        "input[placeholder*='phone' i]",
        "input[placeholder*='mobile' i]",
        "input[name*='phone' i]"
      ]);

      if (phoneInput) {
        return 'phone_required';
      }

      const otpIndicators = await this.browser.firstVisible([
        "button:has-text('Validate')",
        "button:has-text('Verify')",
        "text=/Enter OTP/i",
        "input[data-index]",
        "input[autocomplete='one-time-code']"
      ]);

      if (otpIndicators) {
        return 'otp_required';
      }

      return 'unknown';
    } catch (error) {
      logger.warn(`Auth state detection failed: ${error.message}`);
      return 'unknown';
    }
  }

  async detectAuthState() {
    return this.detectPassiveAuthState();
  }

  async probeAuthenticatedMenu() {
    try {
      const optionsButton = await this.browser.firstVisible([
        "button[aria-label='Options']",
        "[aria-label*='profile' i]",
        "button:has-text('Profile')",
        "button:has-text('Account')"
      ]);

      if (!optionsButton) {
        return false;
      }

      const existingMenu = await this.browser.firstVisible([
        '[role="menu"]',
        '[role="menuitem"]:has-text("My Account")',
        '[role="menuitem"]:has-text("Orders")',
        '[role="menuitem"]:has-text("Logout")'
      ]);

      if (!existingMenu) {
        await optionsButton.click();
      }

      const authenticatedMenuItem = await this.browser.waitForAnyVisible([
        '[role="menuitem"]:has-text("My Account")',
        '[role="menuitem"]:has-text("Orders")',
        '[role="menuitem"]:has-text("Profile")',
        '[role="menuitem"]:has-text("Logout")'
      ], 1200, 150);

      return !!authenticatedMenuItem;
    } catch (error) {
      logger.debug(`Authenticated menu probe failed: ${error.message}`);
      return false;
    }
  }

  async ensureOptionsMenuOpen() {
    const existingMenu = await this.browser.firstVisible([
      '[role="menu"]',
      '[role="menuitem"]:has-text("My Account")'
    ]);
    if (existingMenu) return true;

    const optionsButton = await this.browser.firstVisible([
      "button[aria-label='Options']",
      "[aria-label*='profile' i]",
      "button:has-text('Profile')",
      "button:has-text('Account')"
    ]);

    if (!optionsButton) return false;

    await optionsButton.click();
    const openedMenu = await this.browser.waitForAnyVisible([
      '[role="menuitem"]:has-text("My Account")',
      'text=My Account'
    ], 1500, 150);

    return !!openedMenu;
  }

  async verifyMyAccountNavigationOutcome() {
    try {
      const menuOpen = await this.ensureOptionsMenuOpen();
      if (!menuOpen) {
        return 'unknown';
      }

      const myAccount = await this.browser.firstVisible([
        '[role="menuitem"]:has-text("My Account")',
        "text=My Account",
        "a:has-text('My Account')",
        "button:has-text('My Account')"
      ]);

      if (!myAccount) {
        return 'unknown';
      }

      await myAccount.click();
      await this.browser.waitForPageReady?.(2500);

      const outcome = await this.waitForMyAccountOutcome();
      if (outcome === 'phone_required' || outcome === 'otp_required') {
        logger.info('My Account click redirected to auth flow instead of authenticated account page');
      }

      return outcome;
    } catch (error) {
      logger.warn(`Authenticated access confirmation failed: ${error.message}`);
      return 'unknown';
    }
  }

  async waitForMyAccountOutcome(timeout = 3000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const currentUrl = this.browser.page.url().toLowerCase();

      if (currentUrl.includes('/auth?callbackurl=/rcbian')) {
        return 'phone_required';
      }

      const phoneInput = await this.browser.firstVisible([
        "input[type='tel']:not([data-index])",
        "input[placeholder*='phone' i]",
        "input[placeholder*='mobile' i]",
        "input[name*='phone' i]"
      ]);
      if (phoneInput) {
        return 'phone_required';
      }

      const otpIndicators = await this.browser.firstVisible([
        "button:has-text('Validate')",
        "button:has-text('Verify')",
        "text=/Enter OTP/i",
        "input[data-index]",
        "input[autocomplete='one-time-code']"
      ]);
      if (otpIndicators) {
        return 'otp_required';
      }

      if (currentUrl.includes('/rcbian/mypage') || currentUrl.endsWith('/rcbian') || currentUrl.includes('/rcbian?')) {
        const myAccountPageVisible = await this.browser.firstVisible([
          'text=My Account',
          'button:has-text("My Orders")',
          'button:has-text("Profile")',
          'button:has-text("My Addresses")'
        ]);

        if (myAccountPageVisible) {
          return 'logged_in';
        }
      }

      await this.browser.page.waitForTimeout(150);
    }

    return 'unknown';
  }

  async confirmAuthenticatedAccess() {
    const outcome = await this.verifyMyAccountNavigationOutcome();
    return outcome === 'logged_in';
  }

  async isLoggedIn() {
    try {
      let state = await this.detectPassiveAuthState();
      if (state === 'phone_required' || state === 'otp_required') {
        return false;
      }

      if (state === 'logged_in') {
        return await this.confirmAuthenticatedAccess();
      }

      if (await this.probeAuthenticatedMenu()) {
        return await this.confirmAuthenticatedAccess();
      }

      return await this.confirmAuthenticatedAccess();
    } catch (error) {
      logger.warn(`Login check failed: ${error.message}`);
      return false;
    }
  }

  async checkLoginStatus() {
    return this.isLoggedIn();
  }

  async fillPhoneAndNext() {
    const phoneInput = await this.browser.firstVisible([
      "input[type='tel']:not([data-index])",
      "input[placeholder*='phone' i]",
      "input[placeholder*='mobile' i]",
      "input[name*='phone' i]"
    ]);

    if (!phoneInput) return false;

    await phoneInput.fill(this.account?.phone || config.website.loginPhone);

    const nextBtn = await this.browser.firstVisible([
      "button:has-text('Next')",
      "button:has-text('Continue')",
      "button:has-text('Send OTP')",
      "button[type='submit']"
    ]);

    if (nextBtn) {
      await nextBtn.click();
      return true;
    }

    return false;
  }

  async waitForManualOtpSuccess() {
    const timeoutMs = config.website.otpWaitMinutes * 60 * 1000;
    const start = Date.now();
    let iteration = 0;

    await this.telegram.sendMessage(`🔐 Manual OTP required for ${this.account?.id || 'default account'}. Complete login within ${config.website.otpWaitMinutes} minutes.`);

    while (Date.now() - start < timeoutMs) {
      iteration += 1;

      const state = await this.detectPassiveAuthState();
      if (state === 'logged_in' || (iteration % 3 === 0 && await this.isLoggedIn())) {
        await this.browser.saveSession();
        await this.telegram.sendMessage('✅ Login successful. Session files saved.');
        return true;
      }
      await this.browser.page.waitForTimeout(1500);
    }

    return false;
  }

  async detectAndHandleLogin() {
    let state = await this.detectPassiveAuthState();

    if (state === 'unknown') {
      const loggedIn = await this.isLoggedIn();
      if (loggedIn) {
        await this.browser.saveSession();
        return true;
      }
      state = await this.detectPassiveAuthState();
    }

    if (state === 'logged_in') {
      const confirmed = await this.confirmAuthenticatedAccess();
      if (confirmed) {
        await this.browser.saveSession();
        return true;
      }
      state = await this.detectPassiveAuthState();
    }

    if (state === 'phone_required') {
      await this.fillPhoneAndNext();
    } else if (state === 'otp_required') {
      logger.info('OTP screen already visible; entering OTP wait mode directly');
    } else {
      await this.fillPhoneAndNext();
    }

    const otpOk = await this.waitForManualOtpSuccess();
    return otpOk;
  }
}

module.exports = LoginManager;
