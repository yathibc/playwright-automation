const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config();

function loadAccounts() {
  try {
    const accountsPath = path.join(__dirname, '../../../accounts.json');
    if (fs.existsSync(accountsPath)) {
      const parsed = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      const enabledAccounts = (parsed.accounts || []).filter(account => account && account.enabled !== false);
      if (enabledAccounts.length) {
        return enabledAccounts.map((account, index) => ({
          id: account.id || `acc${index + 1}`,
          phone: account.phone || process.env.LOGIN_PHONE || '7899179393',
          enabled: account.enabled !== false,
          preferredStand: account.preferredStand || process.env.PREFERRED_STAND || 'C Stand',
          fallbackStand: account.fallbackStand || process.env.FALLBACK_STAND || 'B Stand',
          paymentType: String(account.paymentType || process.env.PAYMENT_TYPE || 'UPI').toUpperCase()
        }));
      }
    }
  } catch (_) {}

  return [{
    id: 'acc1',
    phone: process.env.LOGIN_PHONE || '7899179393',
    enabled: true,
    preferredStand: process.env.PREFERRED_STAND || 'C Stand',
    fallbackStand: process.env.FALLBACK_STAND || 'B Stand',
    paymentType: String(process.env.PAYMENT_TYPE || 'UPI').toUpperCase()
  }];
}

const accounts = loadAccounts();

const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  
  website: {
    url: process.env.TICKET_URL || 'https://shop.royalchallengers.com',
    loginPhone: process.env.LOGIN_PHONE || '7899179393',
    timeout: 30000,
    navigationTimeout: 60000,
    otpWaitMinutes: parseInt(process.env.OTP_WAIT_MINUTES) || 5
  },
  
  runtime: {
    timeoutMinutes: parseInt(process.env.TIMEOUT_MINUTES) || 120
  },
  
  seats: {
    preferredStand: process.env.PREFERRED_STAND || 'C Stand',
    fallbackStand: process.env.FALLBACK_STAND || 'B Stand',
    requiredConsecutiveSeats: parseInt(process.env.REQUIRED_CONSECUTIVE_SEATS) || 2,
    retryOccupiedSeatMinutes: parseInt(process.env.RETRY_OCCUPIED_SEAT_MINUTES) || 5
    ,
    matchRetryAttempts: parseInt(process.env.MATCH_RETRY_ATTEMPTS) || 12
  },
  
  sessions: {
    maxParallel: parseInt(process.env.MAX_PARALLEL_SESSIONS) || accounts.length,
    preloadMinutes: parseInt(process.env.SESSION_PRELOAD_MINUTES) || 15
  },
  
  debug: {
    enabled: process.env.DEBUG_MODE === 'true',
    screenshotPath: path.join(__dirname, '../../screenshots'),
    slowMo: process.env.DEBUG_MODE === 'true' ? 1000 : 0
  },

  browser: {
    headless: process.env.HEADLESS === 'true' ? true : false,
  },
  
  match: {
    matchUrl: process.env.MATCH_URL || 'https://shop.royalchallengers.com/ticket/2',
    displayName: process.env.MATCH_DISPLAY_NAME || 'RCB vs SRH',
    keywords: {
      team1: ['RCB', 'Bangalore', 'Royal Challengers'],
      team2: ['SRH', 'Hyderabad', 'Sunrisers']
    },
    bookingButtonLabels: ['Book Now', 'Buy Tickets', 'Tickets', 'Select Seats']
  },

  monitoring: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS) || 3000,
    maxDurationMinutes: parseInt(process.env.MONITOR_DURATION_MINUTES) || 30,
    watchNetworkChanges: true,
    watchUiChanges: true
  },

  networkCapture: {
    enabled: process.env.NETWORK_CAPTURE_ENABLED !== 'false',
    captureBodies: process.env.NETWORK_CAPTURE_BODIES !== 'false'
  },

  checkout: {
    firstName: process.env.FIRST_NAME || 'Yatheendra',
    lastName: process.env.LAST_NAME || 'B C',
    gender: process.env.GENDER || 'MALE',
    address: process.env.ADDRESS || '15 Saptagiri',
    locality: process.env.LOCALITY || '2nd cross 14th main nagendra block',
    pincode: process.env.PINCODE || '560050',
    paymentWaitMinutes: parseInt(process.env.PAYMENT_WAIT_MINUTES) || 10,
    cardOtpWaitMinutes: parseInt(process.env.CARD_OTP_WAIT_MINUTES) || 5
  },

  payment: {
    upiId: process.env.UPI_ID || '7899179393@ybl',
    cardNumber: process.env.CARD_NUMBER || '5241810406450247',
    expiryDate: process.env.EXPIRY_DATE || '01/33',
    cvv: process.env.CVV || '439'
  },

  accounts
};

module.exports = config;
