# Automation Change Tracker

Use this file to keep continuity between future prompts, commands, and runs.

## 2026-03-20

### Added / Created
- `automation_authoring_prompt.txt`
  - Created as the autonomous authoring / maintenance prompt for future UI discovery and code updates.
- `screen_flow.md`
  - Added expected dummy screen flow for login, match discovery, stand selection, seat selection, retry, and cart hold.
- `CHANGE_TRACKER.md`
  - Added as a persistent log of what has been changed and what remains flexible.
- `incremental_update_prompt.txt`
  - Added as the reusable prompt template for repeated UI-change-driven maintenance runs.
- `accounts.json`
  - Added as the shared multi-account configuration file for phone numbers / account IDs.
- `UPI_ID`
  - Treated as the future payment-stage configuration variable for Navi UPI entry.

### Intent of current code changes
- Prepare both TS and Java projects with a skeleton flow now.
- Keep final locator repair and live UI adaptation for later autonomous runs when tickets and seat maps are exposed.
- Ensure future prompts can quickly understand current design decisions.
- Sync code and docs after multi-account and global-timeout refactors.

### Expected stable behavior
- Restore per-account session if present.
- Validate login via Profile -> My Account.
- OTP fallback with 5-minute wait and session save after success.
- Monitor for `RCB vs SRH`.
- Use one global booking timeout per account flow; each later stage gets only remaining time.
- Prefer `C Stand`, then `B Stand`.
- Prefer 2 consecutive seats in rows `R50-R60`, then nearest rows, then any pair in same stand.
- Retry seat selection if **Next** fails because selected seats become occupied.
- Keep browser open on cart success or failure review states.
- Run one browser flow per enabled account.
- Start account/browser flows in parallel immediately instead of serializing login checks.
- Do not stop other accounts if one account already added tickets to cart.
- Planned future payment method is Navi UPI using `UPI_ID=7899179393@naviaxis`.

### Still intentionally flexible
- exact Tickets navigation locator
- exact match card locator
- stand selector locator
- exact SVG/canvas seat interaction logic
- exact cart confirmation locator
- exact backend/network signals proving availability
- final runtime integration of the new multi-account screen-flow skeleton in both TS and Java entrypoints
- explicit post-cart 10-minute hold/monitor phase after booking success
- payment UI automation implementation using Navi UPI + configured `UPI_ID`

### Next autonomous maintenance run should
1. read `prompt.txt`
2. read `automation_authoring_prompt.txt`
3. read `screen_flow.md`
4. read `incremental_update_prompt.txt` when doing delta-based maintenance
5. inspect live UI in headed mode using Playwright MCP
6. update TS + Java locators / flow details only where live UI differs
7. update this file with any new findings or file changes

### Repeated maintenance recommendation
- Use `incremental_update_prompt.txt` for each future UI change.
- Edit only the `For this run, focus specifically on:` section before each run.
- Keep each run narrow and incremental.

## 2026-03-21

### Live UI findings from this run
- The site currently lands on `https://shop.royalchallengers.com/merchandise`.
- Logged-in state is quickly detectable from the header **Options** avatar menu.
- The opened menu now exposes authenticated items including **My Account**, **Orders**, **Addresses**, **Profile**, **Help Center**, and **Logout**.
- Clicking **My Account** navigates to `https://shop.royalchallengers.com/rcbian/mypage` and shows a **My Account** heading with account action cards.
- No newly visible ticketing / seat-map / payment UI was exposed in this run, so no booking-flow locator changes were made outside login-speed optimization.

### Files updated in this run
- `Playwright_TS/src/browser/browser.js`
  - Replaced heavier post-navigation waiting with lighter page-ready logic.
  - Added reusable fast `waitForAnyVisible(...)` helper for quicker auth/login checks.
- `Playwright_TS/src/auth/login.js`
  - Refined auth validation so **Options** menu visibility is no longer treated as login success.
  - Auth now clicks **My Account** and validates the post-click outcome: `/rcbian/mypage` or `/rcbian` with account UI means logged in; `/auth?callbackUrl=/rcbian` or phone UI means login required.
  - Reduced fixed waits around profile/menu handling.
  - Increased OTP/login polling responsiveness and opportunistic Validate/Verify clicking.
- `playwright_java_tickets/src/main/java/com/ticketautomation/browser/BrowserManager.java`
  - Fixed per-account sessionStorage restore to use the actual account id.
  - Added lighter page-load settling and a `waitForAnyVisible(...)` helper.
- `playwright_java_tickets/src/main/java/com/ticketautomation/auth/AuthenticationHandler.java`
  - Refined auth validation so **Options** menu visibility is not treated as sufficient proof of login.
  - Auth now clicks **My Account** and validates `/rcbian/mypage`, `/rcbian`, or `/auth?callbackUrl=/rcbian` outcomes before deciding session validity.
  - Reduced fixed waits and increased OTP completion polling speed.
- `CHANGE_TRACKER.md`
  - Updated with current live UI findings and speed-focused maintenance notes.

### Still pending / fragile
- Tickets navigation and actual booking UI are still not visible in this inspected flow.
- Match card, stand selection, seat map, add-to-cart, and post-cart payment-observation locators still require live verification when ticket UI appears.
- OTP completion still depends on manual action; this run only reduced detection latency after the user completes OTP.
- Session expiry can still happen later during merchandise/ticket navigation, so downstream modules should continue re-checking auth when entering protected flows.
- TS and Java projects still contain other non-login waits in match/seat modules that can be tuned later once ticket UI is available without risking booking-flow stability.

## 2026-03-21 (generic checkout refactor based on shared checkout UI)

### Live UI findings from this run
- The authenticated header avatar/menu can still be visible before checkout, but merchandise **ADD TO BAG** may redirect to `/login`, so checkout auth must be revalidated at add-to-bag time instead of trusting header state alone.
- Product page for **RCB 2026 Royalcat Comfort Slides** is live at the merchandise flow and exposes direct size buttons including **8**, followed by an **ADD TO BAG** CTA.
- After add-to-bag succeeds, the product page now swaps **ADD TO BAG** to **GO TO BAG** and updates the bag count in the top-right icon.
- Checkout is currently rendered at `/checkout` with:
  - prefilled **First name**, **Last name**, **Mobile No**, and **Email**
  - address fields **Address (House no. / Building)**, **Locality (Area / Street)**, optional **Landmark**, **Pincode**, auto-populated **City**, and auto-populated **State**
  - no clearly visible gender control in the inspected checkout state, so gender handling must stay optional/best-effort
  - a required terms checkbox already checked in this observed session
  - **PAY NOW** CTA on the right-side bag summary
- **PAY NOW** currently opens a Juspay-hosted payment page.
- Juspay currently exposes both payment branches needed for automation support:
  - **Cards** tab with **Enter Card Number**, **MM/YY**, **CVV**, and **PAY NOW**
  - **UPI** tab with **Username@bankname** field and **VERIFY AND PAY**

### Files updated in this run
- `Playwright_TS/src/config/config.js`
  - Added per-account `paymentType` and reusable checkout/payment/address config from `.env`.
- `Playwright_TS/src/flows/checkoutFlow.js`
  - Added generic post-cart checkout/payment flow based on the shared checkout UI observed through the live site.
- `Playwright_TS/src/session/parallelController.js`
  - Wired the generic checkout flow after ticket seat/cart success while preserving per-account session separation.
- `playwright_java_tickets/src/main/java/com/ticketautomation/config/AccountConfig.java`
  - Added `paymentType` to mirror `accounts.json`.
- `playwright_java_tickets/src/main/java/com/ticketautomation/config/AccountConfigLoader.java`
  - Added `paymentType` defaulting logic.
- `playwright_java_tickets/src/main/java/com/ticketautomation/config/Config.java`
  - Added reusable checkout/payment env-backed config.
- `playwright_java_tickets/src/main/java/com/ticketautomation/flow/CheckoutFlow.java`
  - Added Java-side generic checkout/payment flow aligned to the currently visible shared checkout UI and Juspay branches.
- `playwright_java_tickets/src/main/java/com/ticketautomation/session/ParallelSessionController.java`
  - Wired the generic checkout flow after ticket seat/cart success while preserving the existing ticket-monitoring structure.
- `playwright_java_tickets/.env`
  - Synced generic checkout/payment fields for the Java runtime and aligned `UPI_ID` to the configured value used in this run.
- `CHANGE_TRACKER.md`
  - Updated to clarify that the retained implementation is generic ticket checkout logic, not merchandise-specific runtime flow.

### Still pending / fragile
- The checkout page did not visibly expose a gender control in this inspected state; code now treats gender selection as optional and should be rechecked if the UI changes.
- Email is currently prefilled on the live site; no new env-driven email override was added because it was not provided in this run.
- Juspay controls appear dynamic and can briefly render a processing state before the selected branch settles; locator fallback is in place, but future UI shifts may require another small repair.
- Success detection after manual payment is still heuristic-based (`order`, `success`, merchant-domain return, confirmation text) and should be tightened once a confirmed post-payment success page is observed.
- Checkout implementation is now generic and intended to be reused after ticket seat/cart success; actual ticket stand/seat UI still needs separate live verification when available.

## 2026-03-21 (live checkout + payment selector optimization run)

### Live UI findings from this run
- Merchandise product flow was used only to reach the shared checkout/payment UI for inspection; no merchandise-specific runtime assumptions should be retained in reusable checkout code.
- Shared checkout still lands at `/checkout` and exposes direct accessible textboxes for:
  - `Address (House no. / Building)`
  - `Locality (Area / Street)`
  - `Pincode`
  - auto-populated `City`
  - auto-populated `State`
- After filling address, locality, and pincode, clicking `PAY NOW` successfully triggered `POST /checkout/proceed` and navigated to Juspay.
- Juspay payment page currently exposes direct visible branches:
  - `Cards`
  - `UPI`
  - `Netbanking`
  - `Wallets`
- Confirmed direct Juspay fields and actions in this run:
  - Cards: `Enter Card Number`, `MM/YY`, `CVV`, `PAY NOW`
  - UPI: `Username@bankname`, `VERIFY AND PAY`
- Confirmed current configured UPI path can fill `7899179393@ybl` and click `VERIFY AND PAY`.
- Network also confirmed checkout/payment progression via:
  - `POST https://rcbscaleapi.ticketgenie.in/checkout/proceed`
  - Juspay page load and payment-method config fetches.

### Files updated in this run
- `Playwright_TS/src/flows/checkoutFlow.js`
  - Replaced broader/fallback-heavy checkout field handling with faster direct accessible-name fills for address fields.
  - Added explicit shipping-address fill helper and post-pincode stabilization.
  - Tightened payment gateway detection and direct branch selection for `Cards` and `UPI`.
  - Kept config-driven UPI/card values and added card-vs-UPI-specific manual wait behavior.
- `playwright_java_tickets/src/main/java/com/ticketautomation/flow/CheckoutFlow.java`
  - Mirrored the same direct checkout/address and Juspay payment selector improvements from TS.
  - Added config-driven branch-specific handling for UPI and card flow with faster locators.
- `prompt.txt`
  - Updated source-of-truth requirement from non-payment automation to config-driven checkout payment automation.
- `screen_flow.md`
  - Updated flow skeleton to include current shared checkout/payment automation and confirmed Juspay structure.
- `automation_authoring_prompt.txt`
  - Updated maintenance guidance so payment automation is allowed when live UI is verified and config-driven.
- `CHANGE_TRACKER.md`
  - Added this run’s live UI findings and exact selector/documentation updates.

### Still pending / fragile
- Ticket-specific stand/seat selection UI is still not live/confirmed in this run; only shared checkout/payment was validated.
- Juspay emits repeated console warnings and a `split_bundles/undefined` 403 asset issue, but the page still rendered usable payment controls.
- The MCP inspection confirmed UPI fill/click and card field visibility, but post-click payment success still depends on real bank/UPI approval outcomes and may vary by provider.
- Final order-success detection after payment remains heuristic and should be tightened once a confirmed RCB post-payment success page is captured.
- Through the screen flow, observe the backend network requests/responses and record it in a file(har file if possible) so that it can be viewed. 
