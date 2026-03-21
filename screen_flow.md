# Ticket Automation Screen Flow Skeleton

This file captures the expected end-to-end screen flow that both the TS and Java projects should implement now as a reusable skeleton.

This flow supports multiple accounts / multiple browser sessions.
Each enabled account should get its own browser, session files, screenshots, and runtime state.

## 1. Startup / Session Restore
- Launch browser in headed mode.
- Open `https://shop.royalchallengers.com`.
- If present, load per-account session files:
  - `sessions/<account_id>/user_session.json`
  - `sessions/<account_id>/session_storage.json`
- Reload after restore so authenticated state is reflected.
- Start observing UI and network/backend changes.

## 2. Login Validation
- Click profile icon.
- Click **My Account**.
- Treat user as logged in only if My Account page loads and profile/details are visible.

## 3. OTP Login Flow
- If not logged in for the current account/browser:
  - enter `7899179393`
  - click **Next**
  - pause up to 5 minutes for manual OTP entry
  - resume automatically when authenticated state is detected
- Save both per-account session files only after successful login.
- If restored session was invalid, overwrite saved files only after fresh successful login.

## 4. Match Discovery
- Search for `RCB vs SRH`.
- Detect using both UI changes and backend/network changes.
- After login/session restore is confirmed, start recording backend network requests/responses to JSON and HAR artifacts for later analysis.
- All stages in the booking flow share one total booking timeout per account/browser.
- Example: if total timeout is 10 minutes and match discovery consumes 7 minutes, all remaining stages together get only the remaining 3 minutes.
- If match not found, take screenshot, log reason, keep browser open.

## Global Timeout Rule
- Timeout is global for the full booking flow of each account/browser.
- Do not reset timeout per step.
- Every stage must use remaining time only.

## Parallel Startup Rule
- All enabled account/browser flows should launch immediately in parallel.
- Do not wait for one browser to finish login or session validation before starting the others.

## 5. Availability Check
- Check whether tickets are available.
- If unavailable, take screenshot, log reason, keep browser open.

## 6. Stand Selection Priority
- Try `C Stand` first.
- If unavailable, try `B Stand`.
- If neither available, stop, notify, screenshot, log reason, keep browser open.

## 7. Seat Selection Priority
- Need exactly 2 consecutive seats in the same stand.
- Priority order:
  1. any 2 consecutive seats in `C Stand`
  2. if unavailable, any 2 consecutive seats in `B Stand`

## 8. Retry On Occupied Seat
- After selecting seats and clicking **Next**, if flow fails because seats are already occupied / unavailable / rejected, retry.
- Retry within same stand first.
- Re-scan seat availability and select a new valid pair.
- Continue until navigation reaches the next page or options are exhausted.

## 9. Cart State / Checkout
- Add to Bag.
- Go to Bag.
- Any monitoring strategy that succeeds in seat selection must use the same checkout continuation path.
- Do not stop other account/browser sessions if one account already reached cart.
- Let other accounts continue trying to add their own tickets to cart.

## 9a. Payment Automation
- Payment flow should use config-driven values only.
- Do not embed merchandise-specific runtime assumptions into reusable code; only reuse the shared checkout/payment structure.
- If payment method is `UPI`:
  - select `UPI`
  - enter configured `UPI_ID`
  - click `VERIFY AND PAY`
  - wait for manual approval completion
- If payment method is `CARD`:
  - select `Cards`
  - enter configured card number, expiry, and CVV
  - click `PAY NOW`
  - wait up to 5 minutes for manual OTP / 3DS completion

## 9b. Current Confirmed Shared Checkout Structure
- Checkout exposes `First name`, `Last name`, `Mobile No`, `Email`
- Shipping exposes `Address (House no. / Building)`, `Locality (Area / Street)`, optional `Landmark`, `Pincode`, `City`, `State`
- `PAY NOW` transitions to Juspay
- Juspay currently exposes `Cards`, `UPI`, `Netbanking`, and `Wallets`

## 10. Failure State Handling
For any of these:
- session invalid and OTP not completed
- match not found
- tickets unavailable
- stand unavailable
- no 2 consecutive seats
- retries exhausted

Do:
- screenshot
- log exact reason
- keep browser open for manual review

## 11. Autonomous Maintenance Later
When the live ticket/seat UI changes or becomes available:
- use Playwright MCP in headed mode
- compare actual screens with this expected flow
- patch locators and interaction logic in TS and Java code
- preserve the same high-level screen flow
