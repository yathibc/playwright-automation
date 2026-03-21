# 🎟 Ticket Booking Automation System

A Playwright-based ticket monitoring and booking framework with multi-account browser sessions, dynamic DOM detection, and real-time notifications.

## 🚀 Features

### Core Capabilities
- **Dynamic DOM Exploration**: Intelligent element detection without relying on static selectors
- **Multi-Account Parallel Control**: Multiple account/browser sessions can run in parallel using `accounts.json`
- **Event-Driven Monitoring**: Real-time detection using MutationObserver and network monitoring
- **Smart Seat Selection**: Consecutive seat algorithm with fallback strategies
- **Unified Checkout Path**: All successful monitoring strategies continue into the same checkout flow
- **Per-Account Session Persistence**: Automatic login detection and isolated session saving per account

### Advanced Features
- **Multi-Format Seat Map Support**: SVG, HTML grid, and Canvas implementations
- **Runtime Window Enforcement**: Operates only within specified time windows
- **Debug Mode**: Screenshots, overlays, and detailed logging for troubleshooting
- **Telegram Notifications**: Real-time alerts for login requirements and booking success
- **Graceful Error Handling**: Comprehensive error recovery and reporting

## 📋 Requirements

- Node.js 16+
- Chrome/Chromium browser
- Telegram Bot Token and Chat ID (optional but recommended)

## 🛠 Installation

1. **Clone and Setup**
```bash
git clone <repository-url>
cd ticket-booking-automation
npm install
```

2. **Configure Environment**
```bash
cp .env .env
# Edit .env with your configuration
```

3. **Install Playwright Browsers**
```bash
npx playwright install chromium
```

## ⚙️ Configuration

### Environment Variables (.env)

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Ticket Website Configuration
TICKET_URL=https://example-ticket-website.com
DEBUG_MODE=false

# Runtime Window (24-hour format)
RUNTIME_START=11:00
RUNTIME_END=12:30

# Seat Preferences
PREFERRED_STAND=C Stand
FALLBACK_STAND=B Stand

# Post-login network capture
NETWORK_CAPTURE_ENABLED=true
NETWORK_CAPTURE_BODIES=true

# Session / Multi-account Configuration
MAX_PARALLEL_SESSIONS=5
SESSION_PRELOAD_MINUTES=15

# Planned future payment configuration
UPI_ID=7899179393@naviaxis
```

### Key Settings

- **Global Booking Timeout**: Each account flow uses one total timeout budget for the entire booking flow
- **Target Match**: RCB vs SRH (configurable in `src/config/config.js`)
- **Preferred Seats**: Choose any 2 consecutive available seats in the preferred stand; if unavailable, try the fallback stand
- **Post-Login Network Capture**: Save detailed JSON and HAR artifacts for backend analysis after authentication is confirmed
- **Parallel Sessions**: One browser flow per enabled account in `accounts.json`
- **Planned Payment Config**: `UPI_ID` can be used later when Navi UPI payment UI automation is implemented

## 🎯 Usage

### Basic Usage
```bash
npm start
```

This currently runs the main Node entrypoint and starts all enabled account/browser flows in parallel.

### Development Mode
```bash
npm run dev
```

### Debug Mode
Set `DEBUG_MODE=true` in `.env` to enable:
- Screenshots at key steps
- Visual seat overlays
- Slow browser actions
- Detailed console logs
- Network request logging

## 🏗 Architecture

### Core Modules

```
src/
├── index.js                    # Main orchestrator
├── config/
│   └── config.js              # Configuration management
├── browser/
│   └── browser.js             # Browser automation core
├── auth/
│   └── login.js               # Login detection & management
├── detection/
│   ├── matchDetector.js       # Match detection with DOM exploration
│   └── seatMapDetector.js     # Seat map type detection
├── selection/
│   └── seatSelector.js        # Consecutive seat selection
├── monitoring/
│   └── eventMonitor.js        # Event-driven monitoring
├── session/
│   └── parallelController.js  # Multi-account parallel session management
├── notifications/
│   └── telegram.js            # Telegram bot integration
└── utils/
    ├── logger.js              # Structured logging
    ├── debug.js               # Debug utilities
    └── timeWindow.js          # Runtime window management
```

### Workflow

1. **Startup Phase**
   - Load enabled accounts from `accounts.json`
   - Start browser flows in parallel
   - Restore per-account sessions from `sessions/<account_id>/`
   - Handle login if required

2. **Monitoring / Booking Phase**
   - After login/session restore succeeds, per-session network capture starts automatically
   - Each account gets one global timeout budget for the full booking flow
   - Match detection with dynamic exploration
   - Availability detection through event-driven and polling strategies
   - Stand selection priority: `C Stand` then `B Stand`
   - Seat selection priority: any 2 consecutive available seats in the chosen stand
   - Retry if seat confirmation fails because seats become occupied

3. **Cart Phase**
   - Seat map detection (SVG/HTML/Canvas)
   - Cart verification
   - All strategies that successfully select seats continue through the same checkout flow
   - Leave successful browser(s) open for manual payment

## 🌐 Network Capture Artifacts

After login is confirmed for a session, the JS automation records backend/network activity into:

- `logs/network/<account>-session<id>.json`
- `logs/har/<account>-session<id>.har`

These files are intended for later analysis so API behavior can be studied and possibly used to reduce UI dependency in future iterations.

Notes:
- capture begins only after authenticated state is confirmed
- HAR and JSON may contain sensitive headers, cookies, payloads, and response bodies
- keep these files private and avoid sharing them without redaction

## 🔧 Advanced Configuration

### Customizing Match Detection

Edit `src/config/config.js`:

```javascript
match: {
  keywords: {
    team1: ['RCB', 'Bangalore', 'Royal Challengers'],
    team2: ['SRH', 'Hyderabad', 'Sunrisers']
  },
  bookingButtonLabels: ['Book Now', 'Buy Tickets', 'Tickets', 'Select Seats']
}
```

### Seat Selection Priorities

1. **Priority 1**: any 2 consecutive seats in C Stand
2. **Priority 2**: if unavailable, repeat the same logic in B Stand

### Multi-Account Strategy

- Define accounts in `accounts.json`
- Each enabled account gets its own browser/session files
- One account reaching cart must **not** stop other accounts
- Session files are stored under `sessions/<account_id>/`

## 🐛 Debugging

### Enable Debug Mode
```env
DEBUG_MODE=true
```

### Debug Features
- **Screenshots**: Automatic capture at key steps
- **Seat Overlays**: Visual highlighting of available seats
- **Network Logging**: API request/response tracking
- **Performance Metrics**: Page load timing analysis
- **DOM Structure**: Element attribute logging

### Log Files
- `logs/automation.log`: Main application logs
- `screenshots/`: Debug screenshots
- `sessions/<account_id>/`: Saved per-account browser sessions

## 📱 Telegram Integration

### Setup Bot
1. Create bot with @BotFather
2. Get bot token
3. Get chat ID (send message to bot, check updates)

### Notification Types
- 🚀 Automation started
- 🔐 Login required
- 🏏 Match detected
- 🎫 Tickets booked
- ❌ Error notifications
- ⏰ Window status

## ⚠️ Important Notes

### Safety & Compliance
- **No Payment Automation**: System stops at cart, manual checkout required
- **Planned Future Payment Mode**: when enabled later, use Navi UPI and read the UPI value from `UPI_ID`
- **Session Persistence**: Stores per-account authentication/session state
- **Rate Limiting**: Built-in delays to avoid detection
- **Respect Terms of Use**: Use responsibly

### Performance Considerations
- **Memory Usage**: Each session uses ~200MB RAM
- **Network Bandwidth**: Multiple parallel requests
- **CPU Usage**: DOM processing and image analysis

### Troubleshooting

#### Login Issues
- Check Telegram notifications for login prompts
- Verify session files in `sessions/<account_id>/` directories
- Clear sessions if login state corrupted

#### Seat Detection Issues
- Enable debug mode for screenshots
- Check seat map type detection logs
- Verify seat attribute extraction

#### Performance Issues
- Reduce parallel session count
- Disable debug mode in production
- Monitor system resources

#### OTP Rate Limit Situations
- Avoid `npm start` when OTP capacity is exhausted.
- Prefer code compilation/syntax validation and resume live execution later when OTP entry can complete.

## 🔄 Testing

### Test Mode
1. Set `DEBUG_MODE=true`
2. Use test event instead of real match
3. Verify login detection
4. Test seat selection logic

### Test Checklist
- [ ] Login flow works
- [ ] Match detection finds target
- [ ] Seat map loads correctly
- [ ] Consecutive seats selected
- [ ] Cart verification passes
- [ ] Telegram notifications sent

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Test thoroughly
4. Submit pull request

## 📞 Support

For issues and questions:
1. Check debug logs
2. Review configuration
3. Verify environment setup
4. Check GitHub issues

---

**Disclaimer**: This tool is for educational purposes. Use responsibly and in accordance with website terms of service.
