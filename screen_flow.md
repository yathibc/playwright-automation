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
13. **No CSS zoom** — browser stays at 100%. Seat selection uses the Konva slider zoom (set programmatically to 0.3) instead.
14. **Start Konva interceptor** BEFORE any stand interaction (captures seat-template + seatlist)
15. **Dismiss "Continue" popup** if terms/info modal appears

---

## Phase 4: Stand Selection + Seat Modal (~2-5s per stand)

16. **For each stand** in `config.seats.standPriority`:
  - **Ensure no modal is blocking**: If a seat modal is still open from a previous attempt, close it first (click X or press Escape)
  - Click stand using XPath: `//p[text()='CATEGORY']/following-sibling::div[1]//p[text()="{standName}"]`
17. **Wait for intercepted data**: seat-template (S3 JSON) + seatlist (API response) — fires immediately on stand click
  - Timeout: `config.timeouts.seatDataInterceptMs` (default 10s)
18. **Wait for seat modal to open**: The seat selection modal (Chakra UI dialog with Konva canvas) opens automatically when a stand with `is_seat_selection == "Y"` is clicked and seats are available. No ticket count dialog needed.
  - Detects modal via: `.chakra-modal__body canvas`, `[role="dialog"] canvas`
  - Timeout: 8s
19. **If no seats available or modal doesn't open**: Close modal if open, move to next stand

---

## Phase 5: Seat Calculation & Selection — Konva Canvas (~1s)

20. **React settle wait (400ms)**: After the seat modal opens, wait for the website's React to process the seatlist response and render Konva canvas nodes. The modal is freshly created each time (Konva scale resets to default 0.65), and React Query's `useEffect` needs time to merge seatlist data into the seat template and update the Konva stage.
21. **KonvaSeatMapResolver**: Merge seat-template (layout) with seatlist (availability)
  - Filter: `status === 'O'` (Open) AND `bucket === pool` (Online)
  - Calculate Konva internal coordinates using reverse-engineered algorithm
  - Find N consecutive available seats in same row (randomly selected to avoid parallel conflicts)
22. **Set Konva stage scale to 0.3** (first attempt only) — programmatically set via `setKonvaStageScale()` (equivalent to slider at minimum). Ensures all seats fit within the modal viewport. Resets drag offset to (0,0). On **retry attempts within the same stand** (e.g., after SEAT NOT AVAILABLE), the scale is NOT re-set to avoid racing with React's own re-rendering of the Konva nodes.
23. **Canvas stability check**: Read canvas state twice with a 150ms gap. If the bounding rect or scale drifts (React still rendering), wait an extra 300ms before proceeding. This ensures the intercepted data and the rendered canvas are in sync.
24. **Convert to browser coordinates**: `browserX = (canvasRect.left + (konvaX + 9) * konvaScale) / cssZoom` — accounts for canvas bounding rect, Konva stage scale, drag offset, and CSS zoom (should be 1.0)
25. **Click each seat** on the **modal canvas**: `page.mouse.click(browserX, browserY)` with 150ms inter-click delay
26. **Click "Proceed"** button inside the modal
27. **Modal state management**:
  - On success: wait for modal to auto-close, then proceed to checkout
  - On seat-level error (SEAT NOT AVAILABLE): wait 1s for fresh seatlist refetch + 400ms React settle, then retry with new seats (modal stays open, scale preserved)
  - On stand-level error: close modal, try next stand
  - On timeout/unknown error: close modal, try next stand

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

30. **Fill checkout details** using per-account overrides (first/last name, email, gender, address, locality, pincode). Defaults are defined in `config.checkout`, and each account in `accounts.json` can supply its own `checkout` section that merges over those values before `CheckoutFlow` runs.
31. **Accept terms** checkbox
32. **Click "PAY NOW"** → Juspay payment gateway (iframe)
33. **Handle payment** using `config.payment` defaults combined with the account’s `payment` overrides:
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
- **Minimal fixed waits**: React settle (400ms), canvas stability check (150ms), seat click delay (150ms) — all tuned to the minimum needed for reliable sync
- **Konva slider zoom 0.3**: Programmatically set via `setKonvaStageScale()` — all seats visible without CSS zoom artifacts. Scale only set on first attempt per stand; retries skip it to avoid racing with React re-renders.
- **Canvas stability verification**: Two-read check ensures React has finished rendering before clicking — prevents stale-data misclicks on 2nd+ attempts
- **`domcontentloaded`**: Instead of `networkidle` for navigation
- **Parallel data**: seat-template + seatlist intercepted simultaneously
- **Pre-calculated coordinates**: Konva coords computed while UI renders
- **Optimized retry path**: SEAT NOT AVAILABLE retry waits only 1s for refetch (down from 1.5s) + 400ms React settle, then immediately retries with fresh data
