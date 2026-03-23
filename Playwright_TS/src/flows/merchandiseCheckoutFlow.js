const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('MerchandiseCheckout');

class MerchandiseCheckoutFlow {
  constructor(browserManager, telegramNotifier) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
  }

  async executeCheckout() {
    try {
      logger.info('Starting merchandise checkout flow');
      
      // Navigate to merchandise section
      const merchNavSuccess = await this.navigateToMerchandise();
      if (!merchNavSuccess) {
        logger.error('Failed to navigate to merchandise section');
        return false;
      }

      // Select merchandise items
      const selectionSuccess = await this.selectMerchandise();
      if (!selectionSuccess) {
        logger.error('Failed to select merchandise items');
        return false;
      }

      // Proceed to checkout
      const checkoutSuccess = await this.proceedToCheckout();
      if (!checkoutSuccess) {
        logger.error('Failed to proceed to checkout');
        return false;
      }

      // Fill checkout form
      const formSuccess = await this.fillCheckoutForm();
      if (!formSuccess) {
        logger.error('Failed to fill checkout form');
        return false;
      }

      // Complete payment
      const paymentSuccess = await this.completePayment();
      if (!paymentSuccess) {
        logger.error('Failed to complete payment');
        return false;
      }

      logger.info('Merchandise checkout completed successfully');
      await this.telegram.sendMessage('🛍️ ✅ *Merchandise Checkout Completed*\n\nOrder placed successfully!');
      return true;

    } catch (error) {
      logger.error(`Merchandise checkout failed: ${error.message}`);
      await this.telegram.sendMessage('🛍️ ❌ *Merchandise Checkout Failed*\n\nError: ' + error.message);
      return false;
    }
  }

  async navigateToMerchandise() {
    try {
      // Look for merchandise/shop navigation
      const merchLinks = await this.browser.firstVisible([
        'a:has-text("Merchandise")',
        'a:has-text("Shop")',
        'a:has-text("Store")',
        'button:has-text("Merchandise")',
        '[href*="merch"]',
        '[href*="shop"]'
      ]);

      if (merchLinks) {
        await merchLinks.click();
        await this.browser.waitForNavigation();
        logger.info('Navigated to merchandise section');
        return true;
      }

      logger.warn('Merchandise navigation link not found');
      return false;
    } catch (error) {
      logger.error(`Error navigating to merchandise: ${error.message}`);
      return false;
    }
  }

  async selectMerchandise() {
    try {
      // Look for available merchandise items
      const merchItems = await this.browser.firstVisible([
        '.product-card',
        '.merchandise-item',
        '[data-product-id]',
        'article:has(img)',
        '.item-card'
      ]);

      if (merchItems) {
        await merchItems.click();
        await this.browser.waitForNavigation();
        logger.info('Selected merchandise item');
        
        // Check if item is in stock and add to cart
        const addToCartBtn = await this.browser.firstVisible([
          'button:has-text("Add to Cart")',
          'button:has-text("Buy Now")',
          'button:has-text("Add to Bag")',
          '.add-to-cart',
          '[data-action="add-to-cart"]'
        ]);

        if (addToCartBtn) {
          await addToCartBtn.click();
          await this.browser.waitForNavigation();
          logger.info('Added merchandise to cart');
          return true;
        }
      }

      logger.warn('No available merchandise items found');
      return false;
    } catch (error) {
      logger.error(`Error selecting merchandise: ${error.message}`);
      return false;
    }
  }

  async proceedToCheckout() {
    try {
      // Look for cart/checkout buttons
      const checkoutBtn = await this.browser.firstVisible([
        'button:has-text("Checkout")',
        'a:has-text("Checkout")',
        'button:has-text("View Cart")',
        'a:has-text("Cart")',
        '.checkout-button',
        '[data-action="checkout"]'
      ]);

      if (checkoutBtn) {
        await checkoutBtn.click();
        await this.browser.waitForNavigation();
        logger.info('Proceeded to checkout');
        return true;
      }

      logger.warn('Checkout button not found');
      return false;
    } catch (error) {
      logger.error(`Error proceeding to checkout: ${error.message}`);
      return false;
    }
  }

  async fillCheckoutForm() {
    try {
      // Fill personal information
      const personalInfoSuccess = await this.fillPersonalInformation();
      if (!personalInfoSuccess) {
        logger.error('Failed to fill personal information');
        return false;
      }

      // Fill shipping information
      const shippingSuccess = await this.fillShippingInformation();
      if (!shippingSuccess) {
        logger.error('Failed to fill shipping information');
        return false;
      }

      logger.info('Checkout form filled successfully');
      return true;
    } catch (error) {
      logger.error(`Error filling checkout form: ${error.message}`);
      return false;
    }
  }

  async fillPersonalInformation() {
    try {
      // First Name
      const firstNameField = await this.browser.firstVisible([
        'input[name="firstName"]',
        'input[name="first_name"]',
        'input[placeholder*="First Name"]',
        '#firstName'
      ]);

      if (firstNameField) {
        await firstNameField.fill(config.checkout.firstName);
      }

      // Last Name
      const lastNameField = await this.browser.firstVisible([
        'input[name="lastName"]',
        'input[name="last_name"]',
        'input[placeholder*="Last Name"]',
        '#lastName'
      ]);

      if (lastNameField) {
        await lastNameField.fill(config.checkout.lastName);
      }

      // Gender
      const genderField = await this.browser.firstVisible([
        'select[name="gender"]',
        'input[name="gender"][value="MALE"]',
        'input[type="radio"][value="MALE"]'
      ]);

      if (genderField) {
        if (genderField.tagName === 'SELECT') {
          await genderField.selectOption({ label: config.checkout.gender });
        } else {
          await genderField.click();
        }
      }

      logger.info('Personal information filled');
      return true;
    } catch (error) {
      logger.error(`Error filling personal information: ${error.message}`);
      return false;
    }
  }

  async fillShippingInformation() {
    try {
      // Address
      const addressField = await this.browser.firstVisible([
        'input[name="address"]',
        'input[name="address1"]',
        'input[placeholder*="Address"]',
        '#address'
      ]);

      if (addressField) {
        await addressField.fill(config.checkout.address);
      }

      // Locality
      const localityField = await this.browser.firstVisible([
        'input[name="locality"]',
        'input[name="city"]',
        'input[placeholder*="City"]',
        'input[placeholder*="Locality"]'
      ]);

      if (localityField) {
        await localityField.fill(config.checkout.locality);
      }

      // Pincode
      const pincodeField = await this.browser.firstVisible([
        'input[name="pincode"]',
        'input[name="postalCode"]',
        'input[placeholder*="Pincode"]',
        'input[placeholder*="Postal"]'
      ]);

      if (pincodeField) {
        await pincodeField.fill(config.checkout.pincode);
      }

      logger.info('Shipping information filled');
      return true;
    } catch (error) {
      logger.error(`Error filling shipping information: ${error.message}`);
      return false;
    }
  }

  async completePayment() {
    try {
      // Proceed to payment section
      const continueToPaymentBtn = await this.browser.firstVisible([
        'button:has-text("Continue to Payment")',
        'button:has-text("Proceed to Payment")',
        'button:has-text("Next")',
        '.continue-payment'
      ]);

      if (continueToPaymentBtn) {
        await continueToPaymentBtn.click();
        await this.browser.waitForNavigation();
      }

      // Select payment method (UPI by default)
      const paymentSuccess = await this.selectPaymentMethod();
      if (!paymentSuccess) {
        logger.error('Failed to select payment method');
        return false;
      }

      // Place order
      const placeOrderBtn = await this.browser.firstVisible([
        'button:has-text("Place Order")',
        'button:has-text("Complete Order")',
        'button:has-text("Pay Now")',
        'button:has-text("Confirm Order")',
        '.place-order'
      ]);

      if (placeOrderBtn) {
        await placeOrderBtn.click();
        
        // Wait for order confirmation
        await this.browser.waitForNavigation();
        
        const orderConfirmation = await this.browser.firstVisible([
          'text=Thank you',
          'text=Order confirmed',
          'text=Order placed',
          '.order-success',
          '.confirmation-message'
        ]);

        if (orderConfirmation) {
          logger.info('Order placed successfully');
          return true;
        }
      }

      logger.warn('Place order button not found');
      return false;
    } catch (error) {
      logger.error(`Error completing payment: ${error.message}`);
      return false;
    }
  }

  async selectPaymentMethod() {
    try {
      // Check if UPI is available and preferred
      const upiOption = await this.browser.firstVisible([
        'input[name="paymentMethod"][value="UPI"]',
        'input[type="radio"][value="upi"]',
        'button:has-text("UPI")',
        '.upi-payment'
      ]);

      if (upiOption) {
        await upiOption.click();
        
        // Fill UPI ID
        const upiIdField = await this.browser.firstVisible([
          'input[name="upiId"]',
          'input[placeholder*="UPI"]',
          'input[placeholder*="@"]'
        ]);

        if (upiIdField) {
          await upiIdField.fill(config.payment.upiId);
          logger.info('UPI payment method selected and filled');
          return true;
        }
      }

      // Fallback to card payment
      const cardOption = await this.browser.firstVisible([
        'input[name="paymentMethod"][value="CARD"]',
        'input[type="radio"][value="card"]',
        'button:has-text("Credit Card")',
        'button:has-text("Debit Card")'
      ]);

      if (cardOption) {
        await cardOption.click();
        
        // Fill card details
        const cardSuccess = await this.fillCardDetails();
        if (cardSuccess) {
          logger.info('Card payment method selected and filled');
          return true;
        }
      }

      logger.warn('No payment method available');
      return false;
    } catch (error) {
      logger.error(`Error selecting payment method: ${error.message}`);
      return false;
    }
  }

  async fillCardDetails() {
    try {
      // Card Number
      const cardNumberField = await this.browser.firstVisible([
        'input[name="cardNumber"]',
        'input[name="card_number"]',
        'input[placeholder*="Card Number"]',
        'input[placeholder*="XXXX"]'
      ]);

      if (cardNumberField) {
        await cardNumberField.fill(config.payment.cardNumber);
      }

      // Expiry Date
      const expiryField = await this.browser.firstVisible([
        'input[name="expiry"]',
        'input[name="expiryDate"]',
        'input[placeholder*="MM/YY"]',
        'input[placeholder*="Expiry"]'
      ]);

      if (expiryField) {
        await expiryField.fill(config.payment.expiryDate);
      }

      // CVV
      const cvvField = await this.browser.firstVisible([
        'input[name="cvv"]',
        'input[name="cvc"]',
        'input[placeholder*="CVV"]',
        'input[placeholder*="CVC"]'
      ]);

      if (cvvField) {
        await cvvField.fill(config.payment.cvv);
      }

      logger.info('Card details filled');
      return true;
    } catch (error) {
      logger.error(`Error filling card details: ${error.message}`);
      return false;
    }
  }
}

module.exports = MerchandiseCheckoutFlow;