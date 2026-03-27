# 🎟️ RCB Ticket Automation

API-first hybrid ticket monitoring and booking automation built with Node.js and Playwright.

This project is designed for high-speed ticket drops where seats sell out quickly. It uses direct API polling for event discovery and seat data wherever possible, while still using the browser for the parts that require real UI interaction such as login, Konva/canvas seat clicks, checkout, and payment initiation.

## Overview

The automation supports:

- parallel multi-account execution
- persisted sessions per account
- API-based event discovery
- Konva/canvas seat-map handling
- stand-priority and consecutive-seat selection
- checkout automation with per-account overrides
- Telegram notifications
- network/HAR capture for later analysis

It is optimized for the Royal Challengers Bengaluru ticketing flow, but much of the structure is reusable for similar browser + API hybrid ticketing workflows.

## What Is Automated vs Manual

### Automated
- opening the site and restoring saved sessions
- login state detection
- event polling via backend APIs
- target match discovery
- navigation to the live event page
- stand selection and ticket-count selection
- seat selection on Konva/canvas layouts
- add-to-cart response handling and retry logic
- checkout form filling
- payment method selection and payment initiation
- logging, screenshots, Telegram alerts, and network capture

### Still manual
- OTP entry during login when session reuse is not available
- final payment approval / UPI authorization / card OTP / bank confirmation

## Key Features

- **API-first hybrid flow**: uses backend APIs for fast discovery and browser automation only where necessary
- **Parallel account execution**: one session per enabled account, all racing independently
- **Per-account persistence**: saved storage/session state under `sessions/<account_id>/`
- **Seat retry intelligence**: retries new seats or moves to the next stand based on add-to-cart responses
- **Konva/canvas support**: resolves seat coordinates for canvas-based maps
- **Config-driven runtime**: timeouts, stands, payment defaults, match criteria, and polling are environment-controlled
- **Telegram notifications**: startup, login, event found, tickets added, checkout reached, errors, and summary
- **Network capture artifacts**: JSON and HAR files saved for debugging and reverse engineering

## Project Structure

```text
src/
├── index.js                         # Main parallel booking entry point
├── auth/
│   └── login.js                     # Session reuse + OTP/login handling
├── browser/
│   └── browser.js                   # Playwright/browser lifecycle helpers
├── config/
│   └── config.js                    # Env loading + runtime configuration
├── detection/
│   ├── matchDetector.js             # API-based event discovery
│   └── seatMapDetector.js           # Seat-map detection helpers
├── flows/
│   ├── checkoutFlow.js              # Ticket checkout flow
│   └── merchandiseCheckoutFlow.js   # Optional merchandise checkout helper
├── monitoring/
│   └── eventMonitor.js              # Legacy/alternate monitoring strategy helpers
├── notifications/
│   └── telegram.js                  # Telegram integration
├── selection/
│   └── seatSelector.js              # Seat selection logic
├── session/
│   └── parallelController.js        # Session preload/monitoring controller utilities
├── test/
│   └── ...                          # Manual test/debug scripts
└── utils/
    ├── debug.js
    ├── konvaCanvasInterceptor.js
    ├── konvaSeatMapResolver.js
    ├── logger.js
    ├── networkCapture.js
    └── timeWindow.js
```

Other useful files:

- `screen_flow.md` - detailed runtime booking flow documentation
- `LOCATORS_E2E.md` - locator notes / selector references
- `data/` - captured sample payloads, seat templates, bundles, and API references
- `logs/` - application logs and network artifacts
- `sessions/` - per-account saved session state

## Requirements

- Node.js 16+
- npm
- Playwright-compatible Chromium browser
- Telegram bot token + chat ID for notifications (optional)

## Installation

```bash
npm install
```

If Playwright browsers are not installed yet:

```bash
npx playwright install
```

## Configuration

Configuration is loaded from `.env` and optional `accounts.json`.

### 1) `.env`

Example structure:

```env
# Telegram
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Website / login
TICKET_URL=https://shop.royalchallengers.com
LOGIN_PHONE=9876543210

# Match targeting
MATCH_URL=https://shop.royalchallengers.com/ticket/2
MATCH_DISPLAY_NAME=RCB vs SRH
TARGET_TEAM1=Royal Challengers Bengaluru
TARGET_TEAM2=Sunrisers Hyderabad
REQUIRED_BUTTON_TEXT=BUY TICKETS

# Runtime / polling
TIMEOUT_MINUTES=120
OTP_WAIT_MINUTES=5
EVENT_POLL_MINUTES=60
POLL_INTERVAL_MS=3000
API_POLL_INTERVAL_MS=3000

# Seat selection
STAND_PRIORITY=BOAT C STAND,C STAND,BOAT B STAND,B STAND
REQUIRED_CONSECUTIVE_SEATS=2
MATCH_RETRY_ATTEMPTS=12
SEAT_POOL=O

# Browser / debug
HEADLESS=false
BROWSER_ZOOM=0.5
DEBUG_MODE=false

# Sessions
MAX_PARALLEL_SESSIONS=5
SESSION_PRELOAD_MINUTES=15

# Network capture
NETWORK_CAPTURE_ENABLED=true
NETWORK_CAPTURE_BODIES=true

# Payment defaults
PAYMENT_TYPE=UPI
UPI_ID=yourupi@ybl
CARD_NUMBER=xxxx
EXPIRY_DATE=MM/YY
CVV=xxx

# Checkout defaults
FIRST_NAME=First
LAST_NAME=Last
GENDER=MALE
ADDRESS=Address line
LOCALITY=Locality
PINCODE=560001
```

### 2) `accounts.json` (optional but recommended for parallel runs)

If present, `src/config/config.js` loads accounts from `accounts.json` and starts one browser flow per enabled account.

Example shape:

```json
{
  "accounts": [
    {
      "id": "JIO",
      "phone": "9876543210",
      "enabled": true,
      "paymentType": "UPI",
      "standPriority": ["BOAT C STAND", "C STAND"],
      "checkout": {
        "firstName": "Jane",
        "lastName": "Doe",
        "address": "Address",
        "locality": "Locality",
        "pincode": "560001"
      },
      "payment": {
        "upiId": "jane@ybl"
      }
    }
  ]
}
```

If `accounts.json` is missing, the app falls back to a single default account built from `.env`.

## Runtime Flow

The current implementation in `src/index.js` follows this high-level flow:

1. initialize one browser automation system per enabled account
2. restore session or wait for login/OTP completion
3. start network capture
4. poll the ticketing API for the target event
5. navigate to the event page once the event is live
6. apply browser zoom and activate the Konva interceptor
7. iterate stands in configured priority order
8. select ticket count and continue to seat map
9. resolve available consecutive seats from intercepted seat data
10. click seats on canvas and intercept `ticketaddtocart` response
11. react based on response:
    - success -> continue to checkout
    - seat unavailable -> retry new seats in same stand
    - stand limit exceeded -> move to next stand
    - hard limit exceeded -> stop that account flow
12. complete checkout form and initiate payment
13. keep successful browser sessions open for manual payment completion

For the deeper version of this flow, see `screen_flow.md`.

## Usage

### Start ticket automation

```bash
npm start
```

This runs `node src/index.js`.

### Development run

```bash
npm run dev
```

Currently this runs the same entry point as `npm start`.

### Basic test script

```bash
npm test
```

This runs `node src/test/test.js`.

### Other manual test/debug helpers

Additional helper scripts exist in `src/test/`, including:

- `test-browser.js`
- `test-telegram.js`
- `testMerchandiseCheckout.js`
- `testSeatLayout.js`
- `ticketMonitor.js`

These are useful for targeted experimentation and debugging.

## Important Configuration Notes

- **Global timeout**: controlled by `TIMEOUT_MINUTES`
- **OTP wait**: controlled by `OTP_WAIT_MINUTES`
- **Event polling timeout**: controlled by `EVENT_POLL_MINUTES`
- **Seat retry window**: controlled by `SEAT_RETRY_MINUTES`
- **Add-to-cart response timeout**: controlled by `ADD_TO_CART_TIMEOUT_MS`
- **Payment wait window**: controlled by `PAYMENT_WAIT_MINUTES`
- **Stand priority**: controlled by `STAND_PRIORITY` or per-account `standPriority`
- **Seat count**: controlled by `REQUIRED_CONSECUTIVE_SEATS`
- **Browser zoom**: `BROWSER_ZOOM=0.5` is useful so the full stand view fits on screen

## Output Artifacts

### Sessions

Per-account session data is stored under:

```text
sessions/<account_id>/
```

Typical files include:

- `session_storage.json`
- `user_session.json`

### Logs and screenshots

- `logs/automation.log` - application logs
- `screenshots/` - debug screenshots when debug mode is enabled or failures are captured

### Network capture

The app can capture session traffic into artifacts such as:

- `logs/network/<account>-session<id>.json`
- `logs/har/<account>-session<id>.har`

These files can contain sensitive information including cookies, headers, payloads, and response bodies.

**Do not share them publicly without redaction.**

## Telegram Notifications

When Telegram is enabled, the project can send notifications for:

- automation startup
- login success/failure
- event discovery
- tickets added to cart
- checkout reached
- hard-stop conditions
- timeout / summary updates

## Debugging

Enable debug mode in `.env`:

```env
DEBUG_MODE=true
```

Useful debugging capabilities include:

- screenshots at important stages
- detailed logs
- network request capture
- Konva seat-map interception support
- account/session-specific diagnostics

## Troubleshooting

### Login problems
- verify phone/account configuration
- check whether session files are stale or corrupted
- delete the affected account folder under `sessions/` and log in again
- confirm OTP can be entered within the configured timeout

### Event not found
- verify `TARGET_TEAM1`, `TARGET_TEAM2`, and `REQUIRED_BUTTON_TEXT`
- confirm API polling settings and timeout values
- check whether the event naming differs from assumptions

### Seat selection issues
- enable debug mode
- inspect intercepted seat-template and seatlist data
- verify stand names in `STAND_PRIORITY`
- review Konva/canvas-specific logs and screenshots

### Checkout/payment issues
- verify payment defaults and per-account payment overrides
- check if the site flow changed around addons, checkout, or gateway handling
- remember that final payment authorization is intentionally manual

### Performance issues
- reduce parallel sessions
- disable debug mode for live runs
- inspect CPU/RAM usage when multiple browsers are active

## Safety and Usage Notes

- This tool persists account session state locally.
- Captured network artifacts may expose private account data.
- The target site may change UI, API contracts, or anti-automation behavior at any time.
- Use responsibly and in accordance with the site's terms and applicable laws.

## License

MIT

---

**Disclaimer:** This repository is for educational and experimental automation purposes. Use it responsibly and at your own risk.
