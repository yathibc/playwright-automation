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
  // ── Telegram Notifications ──────────────────────────────────────────
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
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

  // ── API endpoints (API-first approach) ──────────────────────────────
  api: {
    baseUrl: process.env.API_BASE_URL || 'https://rcbscaleapi.ticketgenie.in',
    eventListPath: '/ticket/eventlist/O',
    seatListPath: '/ticket/seatlist/{eventGroupCode}/{eventCode}/{standCode}',
    addToCartPath: '/checkout/ticketaddtocart',
    checkoutProceedPath: '/checkout/proceed',
    // S3-hosted static assets (no auth needed)
    seatTemplateUrl: 'https://tg3.s3.ap-south-1.amazonaws.com/revents/seat-template/{standCode}.json',
    standsListUrl: 'https://tg3.s3.ap-south-1.amazonaws.com/revents/standview/standList.json',
    pollIntervalMs: parseInt(process.env.API_POLL_INTERVAL_MS) || 3000
  },

  // ── Target match configuration ──────────────────────────────────────
  match: {
    matchUrl: process.env.MATCH_URL || 'https://shop.royalchallengers.com/ticket/2',
    displayName: process.env.MATCH_DISPLAY_NAME || 'RCB vs SRH',
    // Keywords for API-based event matching
    targetTeam1: process.env.TARGET_TEAM1 || 'Royal Challengers Bengaluru',
    targetTeam2: process.env.TARGET_TEAM2 || 'Sunrisers Hyderabad',
    requiredButtonText: process.env.REQUIRED_BUTTON_TEXT || 'BUY TICKETS',
    // Legacy keywords for UI-based fallback
    keywords: {
      team1: ['RCB', 'Bangalore', 'Bengaluru', 'Royal Challengers'],
      team2: ['SRH', 'Hyderabad', 'Sunrisers']
    },
    bookingButtonLabels: ['Book Now', 'Buy Tickets', 'Tickets', 'Select Seats']
  },

  // ── Seat selection ──────────────────────────────────────────────────
  seats: {
    preferredStand: process.env.PREFERRED_STAND || 'C Stand',
    fallbackStand: process.env.FALLBACK_STAND || 'B Stand',
    // Ordered priority list of stands to try (preferred first, then fallbacks)
    standPriority: (process.env.STAND_PRIORITY || 'BOAT C STAND,C STAND,BOAT B STAND,B STAND')
        .split(',').map(s => s.trim()),
    requiredConsecutiveSeats: parseInt(process.env.REQUIRED_CONSECUTIVE_SEATS) || 2,
    retryOccupiedSeatMinutes: parseInt(process.env.RETRY_OCCUPIED_SEAT_MINUTES) || 5,
    matchRetryAttempts: parseInt(process.env.MATCH_RETRY_ATTEMPTS) || 12,
    pool: process.env.SEAT_POOL || 'O'  // Online pool bucket
  },

  // ── Browser & viewport ─────────────────────────────────────────────
  browser: {
    headless: process.env.HEADLESS === 'true' ? true : false,
    // Zoom level: 0.5 = 50% so entire stand view fits without scrolling
    zoomLevel: parseFloat(process.env.BROWSER_ZOOM) || 0.5
  },

  // ── Timeouts (all config-based, no hardcoded waits) ─────────────────
  timeouts: {
    // Global runtime timeout (minutes) — overall execution deadline
    globalMinutes: parseInt(process.env.TIMEOUT_MINUTES) || 120,
    // OTP manual entry timeout (minutes)
    otpWaitMinutes: parseInt(process.env.OTP_WAIT_MINUTES) || 5,
    // Payment completion timeout (minutes) — relaxed, 8 min after checkout
    paymentWaitMinutes: parseInt(process.env.PAYMENT_WAIT_MINUTES) || 10,
    // Card OTP timeout (minutes)
    cardOtpWaitMinutes: parseInt(process.env.CARD_OTP_WAIT_MINUTES) || 5,
    // Event polling timeout (minutes) — how long to poll for event to go live
    eventPollMinutes: parseInt(process.env.EVENT_POLL_MINUTES) || 60,
    // Seat retry timeout (minutes) — how long to retry seat selection per stand
    seatRetryMinutes: parseInt(process.env.SEAT_RETRY_MINUTES) || 3,
    // API response timeout (ms) — max wait for a single API call
    apiResponseMs: parseInt(process.env.API_RESPONSE_TIMEOUT_MS) || 15000,
    // Seat data intercept timeout (ms) — max wait for seat-template + seatlist
    seatDataInterceptMs: parseInt(process.env.SEAT_DATA_INTERCEPT_MS) || 10000,
    // Add-to-cart response timeout (ms)
    addToCartMs: parseInt(process.env.ADD_TO_CART_TIMEOUT_MS) || 15000
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

  // ── Add-to-cart response handling ───────────────────────────────────
  // Error messages from ticketaddtocart API and their actions
  cartErrors: {
    retryNewSeats: ['SEAT NOT AVAILABLE'],
    retryNextStand: ['STAND LIMIT EXCEEDED'],
    hardStop: [
      'MATCH LIMIT EXCEEDED',
      'TRANS LIMIT EXCEEDED',
      'PROFILE LIMIT EXCEEDED',
      'USER LIMIT EXCEEDED',
      'OVER LIMIT'
    ]
  },

  accounts
};

module.exports = config;