# RCB Ticket Automation — Screen Flow (v2.0 API-First Hybrid)

## Architecture
- **API-first**: Uses direct API calls for event discovery and data fetching
- **Browser UI**: Only for login (OTP), seat clicking (Konva canvas), checkout, payment
- **Speed target**: Complete booking in <2 minutes (tickets sell out fast)
- **All timeouts config-based**: No hardcoded waits anywhere

---

## Phase 1: Login & Token Extraction (~30s, mostly OTP wait)

1. **Open** `https://shop.royalchallengers.com`
2. **Detect auth state**: Check if already logged in via saved session
3. **If not logged in**: Enter phone number → Click "Continue" → Wait for manual OTP entry
4. **OTP timeout**: `config.timeouts.otpWaitMinutes` (default 5 min)
5. **After login**: Extract `rtokn` cookie from browser context for API auth
6. **Save session**: storageState + sessionStorage for reuse

---

## Phase 2: Event Discovery — API Polling (~0-3s per poll)

7. **API call**: `GET https://rcbscaleapi.ticketgenie.in/ticket/eventlist/O`
  - Auth: `Authorization: Bearer {rtokn}`
  - Response: `{ status: "Success", result: [{ event_Code, event_Group_Code, event_Name, event_Button_Text, ... }] }`
8. **Match criteria**: `event_Name` contains both target teams AND `event_Button_Text === "BUY TICKETS"`
9. **If not found**: Wait `config.api.pollIntervalMs` (3s) → retry
10. **If found**: Extract `event_Code`, `event_Group_Code` → proceed to Phase 3
11. **Timeout**: `config.timeouts.eventPollMinutes` (default 60 min)

---

## Phase 3: Navigate to Event Page (~2s)

12. **Navigate** to `https://shop.royalchallengers.com/ticket/{event_Code}` (domcontentloaded)
13. **Apply browser zoom** to 50% (`document.body.style.zoom = '0.5'`) so entire stand view fits
14. **Start Konva interceptor** BEFORE any stand interaction (captures seat-template + seatlist)
15. **Dismiss "Continue" popup** if terms/info modal appears

---

## Phase 4: Stand Selection (~1s per stand)

16. **For each stand** in `config.seats.standPriority` (e.g., BOAT C STAND → C STAND → BOAT B STAND → B STAND):
  - Click stand using XPath: `//p[text()='CATEGORY']/following-sibling::div[1]//p[text()="{standName}"]`
  - This opens the seat map modal (Konva canvas)
17. **Select ticket count**: Click the number button (e.g., "2") in "How many tickets?" section
18. **Click "Continue"** to proceed to seat map view
19. **Wait for intercepted data**: seat-template (S3 JSON) + seatlist (API response)
  - Timeout: `config.timeouts.seatDataInterceptMs` (default 10s)

---

## Phase 5: Seat Calculation & Selection — Konva Canvas (~1s)

20. **KonvaSeatMapResolver**: Merge seat-template (layout) with seatlist (availability)
  - Filter: `status === 'O'` (Open) AND `bucket === pool` (Online)
  - Calculate Konva internal coordinates using reverse-engineered algorithm
  - Find N consecutive available seats in same row
21. **Convert to browser coordinates**: Account for canvas bounding rect + Konva stage scale + drag offset + 50% browser zoom
22. **Click each seat** on canvas: `page.mouse.click(browserX, browserY)`
23. **Click "Proceed"** button

---

## Phase 6: Handle ticketaddtocart Response (~0s, event-driven)

24. **Intercept** `checkout/ticketaddtocart` response via `page.waitForResponse()`
25. **Parse response**:

| Response | Action |
|----------|--------|
| `status === "Success"` | ✅ Proceed to Phase 7 (addon/checkout) |
| `message === "SEAT NOT AVAILABLE"` | 🔄 Re-fetch seatlist, pick new seats → retry Phase 5 (same stand) |
| `message === "STAND LIMIT EXCEEDED"` | 🔄 Try next stand → retry Phase 4 |
| `message === "MATCH LIMIT EXCEEDED"` | 🛑 Hard stop — log error, screenshot |
| `message === "TRANS LIMIT EXCEEDED"` | 🛑 Hard stop |
| `message === "PROFILE LIMIT EXCEEDED"` | 🛑 Hard stop |
| `message === "USER LIMIT EXCEEDED"` | 🛑 Hard stop |
| `message === "OVER LIMIT"` | 🛑 Hard stop |

---

## Phase 7: Addon Selection (Metro/Parking) (~1s)

26. **Check** if addon modal appears (from `index.js`: `s.addon == "Y" ? I.onOpen() : T("/checkout")`)
27. **If addon modal**:
  - Click "Free Metro Ticket" radio option
  - Do NOT select "Paid Parking"
  - Click "Continue"
28. **If no addon modal**: App auto-navigates to `/checkout`
29. **Wait for** URL to contain `/checkout`

---

## Phase 8: Checkout & Payment (relaxed, 8+ min)

30. **Fill checkout details**: First name, Last name, Email, Gender, Address, Pincode
31. **Accept terms** checkbox
32. **Click "PAY NOW"** → Juspay payment gateway (iframe)
33. **Handle payment**:
  - **UPI**: Click UPI tab → Fill UPI ID → Click "VERIFY AND PAY"
  - **Card**: Click Cards tab → Fill card number, expiry, CVV → Click "PAY NOW"
34. **Wait for payment completion**: Poll URL + body text for success/failure indicators
  - Timeout: `config.timeouts.paymentWaitMinutes` (default 10 min)

---

## Key API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/ticket/eventlist/O` | GET | Bearer rtokn | List all events |
| `/ticket/seatlist/{groupCode}/{eventCode}/{standCode}` | GET | Bearer rtokn | Available seats for a stand |
| `/checkout/ticketaddtocart` | POST | Bearer rtokn | Add selected seats to cart |
| `/checkout/proceed` | POST | Bearer rtokn | Proceed to payment |
| `tg3.s3.amazonaws.com/revents/seat-template/{standCode}.json` | GET | None | Seat layout template |
| `tg3.s3.amazonaws.com/revents/standview/standList.json` | GET | None | Stand list |

---

## Config-Based Timeouts

| Timeout | Config Key | Default | Description |
|---------|-----------|---------|-------------|
| Global | `TIMEOUT_MINUTES` | 120 min | Overall execution deadline |
| OTP | `OTP_WAIT_MINUTES` | 5 min | Manual OTP entry |
| Event Poll | `EVENT_POLL_MINUTES` | 60 min | How long to poll for event |
| Seat Retry | `SEAT_RETRY_MINUTES` | 3 min | Retry seat selection per stand |
| API Response | `API_RESPONSE_TIMEOUT_MS` | 15s | Single API call timeout |
| Seat Data | `SEAT_DATA_INTERCEPT_MS` | 10s | Wait for seat-template + seatlist |
| Add to Cart | `ADD_TO_CART_TIMEOUT_MS` | 15s | ticketaddtocart response |
| Payment | `PAYMENT_WAIT_MINUTES` | 10 min | Manual payment completion |
| Card OTP | `CARD_OTP_WAIT_MINUTES` | 5 min | Card 3DS/OTP |

---

## Speed Optimizations

- **API-first**: Event discovery via API, not UI scraping
- **Event-driven waits**: `page.waitForResponse()` instead of polling DOM
- **No `waitForTimeout()`**: All waits are event-driven or deadline-based
- **Browser zoom 50%**: Entire stand view visible without scrolling canvas
- **`domcontentloaded`**: Instead of `networkidle` for navigation
- **Parallel data**: seat-template + seatlist intercepted simultaneously
- **Pre-calculated coordinates**: Konva coords computed while UI renders
