/**
 * RCB Ticket Automation — API-First Hybrid Approach (Parallel Multi-Account)
 *
 * Speed-optimized flow: tickets sell out in ~2 minutes.
 * Uses direct API calls for polling/data, browser UI only for actions that require it.
 * All timeouts are config-based. No unnecessary waits.
 *
 * Launches one browser per enabled account in parallel — all race to book tickets.
 */
require('dotenv').config();
const {createModuleLogger} = require('./utils/logger');
const BrowserManager = require('./browser/browser');
const LoginManager = require('./auth/login');
const MatchDetector = require('./detection/matchDetector');
const SeatMapDetector = require('./detection/seatMapDetector');
const SeatSelector = require('./selection/seatSelector');
const CheckoutFlow = require('./flows/checkoutFlow');
const KonvaSeatMapResolver = require('./utils/konvaSeatMapResolver');
const TelegramNotifier = require('./notifications/telegram');
const config = require('./config/config');

const logger = createModuleLogger('Main');

// Shared Telegram notifier instance (singleton across all parallel sessions)
const telegram = new TelegramNotifier();

class TicketAutomationSystem {
    constructor(account, sessionId = 1) {
        this.browser = null;
        this.login = null;
        this.matchDetector = null;
        this.seatMapDetector = null;
        this.seatSelector = null;
        this.checkoutFlow = null;
        this.account = account;
        this.sessionId = sessionId;
        this.tag = `[${account.id}]`;
        this.telegram = telegram;
        this.globalDeadline = Date.now() + (config.timeouts.globalMinutes * 60 * 1000);
        this.discoveredEvent = null;
    }

    getStandPriority() {
        if (Array.isArray(this.account?.standPriority) && this.account.standPriority.length > 0) {
            return this.account.standPriority;
        }
        return config.seats.standPriority;
    }

    hasTimeLeft() {
        return Date.now() < this.globalDeadline;
    }

    remainingMs() {
        return Math.max(0, this.globalDeadline - Date.now());
    }

    async start() {
        logger.info(`${this.tag} 🎟 Starting RCB Ticket Automation — API-First Hybrid v2.1 (session ${this.sessionId})`);
        logger.info(`${this.tag} Global timeout: ${config.timeouts.globalMinutes} min | OTP timeout: ${config.timeouts.otpWaitMinutes} min | Payment timeout: ${config.timeouts.paymentWaitMinutes} min`);
        logger.info(`${this.tag} Target: ${config.match.displayName} | Stands: ${this.getStandPriority().join(' → ')}`);
        logger.info(`${this.tag} Seats needed: ${config.seats.requiredConsecutiveSeats} | Zoom: slider-only (no CSS zoom)`);

        try {
            // Phase 1: Initialize browser + login
            const ready = await this.initializeAndLogin();
            if (!ready) {
                logger.error(`${this.tag} ❌ Initialization or login failed`);
                return false;
            }

            // Phase 2: Event discovery (API polling)
            const event = await this.discoverEvent();
            if (!event) {
                logger.error(`${this.tag} ❌ Target event not found within polling window`);
                return false;
            }

            // Phase 3-7: Navigate, select stand, select seats, add to cart, checkout
            const success = await this.executeBookingFlow(event);

            if (success) {
                logger.info(`${this.tag} 🎉 Booking flow completed — tickets in cart, checkout page reached!`);
                logger.info(`${this.tag} 💳 You have ~8 minutes to complete payment. Browser left open.`);
            } else {
                logger.warn(`${this.tag} ⏰ Booking flow did not complete successfully`);
            }

            return success;
        } catch (error) {
            logger.error(`${this.tag} Fatal error: ${error.message}`);
            logger.error(error.stack);
            return false;
        }
    }

    async preload() {
        logger.info(`${this.tag} Preloading browser and login state for shared-event flow...`);
        return await this.initializeAndLogin();
    }

    async checkLogin() {
        logger.info(`${this.tag} Checking login state for shared-event flow...`);
        // Login (session reuse or OTP)
        this.login = new LoginManager(this.browser, this.account, this.telegram);
        const loggedIn = await this.login.detectAndHandleLogin();
        if (!loggedIn) {
            logger.error(`${this.tag} Login failed or timed out`);
            await this.browser.takeScreenshot(`login_failed_${this.account.id}.png`);
            await this.telegram.sendLoginFailed(this.account.id);
            return false;
        }
        return true;
    }



    // ── Phase 1: Initialize + Login ─────────────────────────────────────

    async initializeAndLogin() {
        logger.info(`${this.tag} Phase 1: Initializing browser and authenticating...`);

        this.browser = new BrowserManager(this.sessionId, this.account);
        const initialized = await this.browser.initialize();
        if (!initialized) return false;

        // Navigate to website
        const navigated = await this.browser.navigateToWebsite();
        if (!navigated) return false;

        // Start network capture
        await this.browser.startNetworkCapture();

        // Login (session reuse or OTP)
        this.login = new LoginManager(this.browser, this.account, this.telegram);
        const loggedIn = await this.login.detectAndHandleLogin();
        if (!loggedIn) {
            logger.error(`${this.tag} Login failed or timed out`);
            await this.browser.takeScreenshot(`login_failed_${this.account.id}.png`);
            await this.telegram.sendLoginFailed(this.account.id);
            return false;
        }

        logger.info(`${this.tag} ✅ Phase 1 complete: Authenticated successfully`);
        await this.telegram.sendLoginSuccess(this.account.id);

        // Initialize other components
        this.matchDetector = new MatchDetector(this.browser);
        this.seatMapDetector = new SeatMapDetector(this.browser);
        this.seatSelector = new SeatSelector(this.browser, this.account);
        this.checkoutFlow = new CheckoutFlow({browserManager: this.browser, account: this.account});

        return true;
    }

    // ── Phase 2: Event Discovery (API-only) ─────────────────────────────

    async discoverEvent() {
        logger.info(`${this.tag} Phase 2: Polling API for target event...`);

        const event = await this.matchDetector.pollForTargetEvent(this.globalDeadline);
        if (!event) {
            await this.telegram.sendMessage(`⏰ *Event Not Found*\n\nAccount: ${this.account.id}\nTarget "${config.match.displayName}" not found within polling window.`);
            return null;
        }

        logger.info(`${this.tag} ✅ Phase 2 complete: Event "${event.event_Name}" (code: ${event.event_Code})`);
        this.discoveredEvent = event;
        await this.telegram.sendMatchFound(`Event: ${event.event_Name}\nCode: ${event.event_Code}\nAccount: ${this.account.id}`);
        return event;
    }

    async startWithKnownEvent(event) {
        if (!event) {
            logger.error(`${this.tag} Cannot start booking flow without a discovered event`);
            return false;
        }

        this.discoveredEvent = event;
        logger.info(`${this.tag} Starting booking flow with shared discovered event ${event.event_Code}`);
        return await this.executeBookingFlow(event);
    }

    // ── Phase 3-7: Booking Flow ─────────────────────────────────────────

    async executeBookingFlow(event) {
        const ticketUrl = this.matchDetector.getTicketPageUrl(event);
        logger.info(`${this.tag} Phase 3: Navigating to ticket page: ${ticketUrl}`);

        const continuePopupSelectors = [
            "button:has-text('Continue')",
            "button:has-text('Proceed')",
            "xpath=//*[@role='dialog' and contains(., 'Continue')]//button"
        ];

        let navigated = false;
        const deadline = Math.min(this.globalDeadline, Date.now() + (config.timeouts.globalMinutes * 60 * 1000));
        let attempt = 0;

        while (Date.now() < deadline) {
            attempt += 1;
            navigated = await this.browser.navigateFast(ticketUrl);
            if (!navigated) {
                logger.warn(`${this.tag} Attempt ${attempt}: Failed to navigate to ticket page, retrying...`);
                continue;
            }

            const btn = await this.browser.waitForAnyVisible(continuePopupSelectors, 10000, 200);
            if (btn) {
                logger.info(`${this.tag} Continue popup detected after ${attempt} attempt(s)`);
                break;
            }

            logger.warn(`${this.tag} Continue popup not visible yet — attempt ${attempt}, refreshing`);
        }

        if (!navigated) {
            logger.error(`${this.tag} Failed to navigate to ticket page within timeout`);
            return false;
        }

        // Start Konva interceptor BEFORE any stand interaction
        await this.browser.startKonvaInterceptor();

        // Click "Continue" if terms/info modal appears (non-blocking, quick check)
        await this._dismissContinuePopup();

        // Wait for page to show ticket UI (CATEGORY section)
        const ticketsLive = await this._waitForTicketsLive();
        if (!ticketsLive) {
            logger.warn(`${this.tag} Ticket UI not detected on page — may need to refresh`);
            // Try refreshing once
            await this.browser.navigateFast(ticketUrl);
            await this._dismissContinuePopup();
        }

        logger.info(`${this.tag} ✅ Phase 3 complete: On ticket page, interceptor active`);

        // Phase 4-6: Stand selection → Seat selection → Add to cart (with retry)
        return await this._standAndSeatLoop(event);
    }

    /**
     * Main retry loop: try each stand in priority order.
     * Within each stand, retry seat selection if seats are taken.
     * Handles all ticketaddtocart response codes.
     */
    async _standAndSeatLoop(event) {
        const standPriority = this.getStandPriority();
        const seatCount = config.seats.requiredConsecutiveSeats;
        let roundNumber = 0;

        // Loop through all stands continuously until global timeout
        while (this.hasTimeLeft()) {
            roundNumber++;
            logger.info(`${this.tag} Stand rotation round ${roundNumber} (${Math.ceil(this.remainingMs() / 1000)}s remaining)`);

            for (let standIdx = 0; standIdx < standPriority.length && this.hasTimeLeft(); standIdx++) {
                const standName = standPriority[standIdx];
                logger.info(`${this.tag} Phase 4: Trying stand "${standName}" (${standIdx + 1}/${standPriority.length})`);

                const interceptor = this.browser.konvaInterceptor;
                if (!interceptor) {
                    logger.error(`${this.tag} Konva interceptor not available`);
                    continue;
                }

                // Check if a seat modal is still open from a previous stand attempt.
                // Do NOT reset interceptor yet — we need the previous data to check
                // if the leftover modal has usable seats.
                // Instead of blindly closing it, check if it has usable seats — the website
                // may have opened it late (after our quick-check skipped the modal wait).
                if (await this._isSeatModalOpen()) {
                    // The open modal might belong to the previous stand click that had seats.
                    // If the interceptor still has data (not yet reset), try to use this modal.
                    if (interceptor.hasData()) {
                        const leftoverData = interceptor.getData();
                        const leftoverList = leftoverData?.seatList?.result || [];
                        const leftoverAvail = leftoverList.filter(s => s.status === 'O' && s.bucket === config.seats.pool);
                        if (leftoverAvail.length > 0) {
                            logger.info(`${this.tag} Leftover modal has ${leftoverAvail.length} available seats for pool "${config.seats.pool}" — using it instead of closing`);
                            // Jump directly to seat selection using this modal and its data
                            // (skip stand click, skip data wait — we already have everything)
                            await this.browser.page.waitForTimeout(400); // React settle
                            const seatRetryDeadline = Date.now() + (config.timeouts.seatRetryMinutes * 60 * 1000);
                            let seatAttemptInStand = 0;
                            let usedLeftoverModal = false;

                            while (Date.now() < seatRetryDeadline && this.hasTimeLeft()) {
                                seatAttemptInStand++;
                                usedLeftoverModal = true;
                                const data = interceptor.getData();
                                const resolver = new KonvaSeatMapResolver({pool: config.seats.pool});
                                const browserZoom = this.browser.getZoomLevel();
                                const browserSeats = await resolver.resolveWithBrowserCoords(
                                    data.seatTemplate, data.seatList, this.browser.page, browserZoom,
                                    seatAttemptInStand === 1
                                );
                                if (browserSeats.length === 0) break;
                                const consecutiveSeats = resolver.findConsecutiveSeats(seatCount);
                                if (!consecutiveSeats) break;
                                const canvasState = await resolver.getCanvasState(this.browser.page);
                                if (!canvasState) break;
                                const seatsToClick = consecutiveSeats.map(seat => {
                                    const {browserX, browserY} = resolver.toBrowserCoords(
                                        seat, canvasState.canvasRect, canvasState.scale, canvasState.stageOffset, browserZoom
                                    );
                                    return {...seat, browserX, browserY};
                                });
                                logger.info(`${this.tag} [Leftover modal] Clicking ${seatCount} seats: ${seatsToClick.map(s =>
                                    `${s.row}${s.seat_No}@(${Math.round(s.browserX)},${Math.round(s.browserY)})`).join(', ')}`);
                                for (const seat of seatsToClick) {
                                    await this.browser.showClickMarker(seat.browserX, seat.browserY, `${seat.row}${seat.seat_No}`);
                                    await this.browser.page.waitForTimeout(150);
                                    await this.browser.page.mouse.click(seat.browserX, seat.browserY);
                                    logger.info(`${this.tag} Clicked seat ${seat.row}${seat.seat_No}`);
                                    await this.browser.page.waitForTimeout(150);
                                }
                                const proceedClicked = await this._clickProceedButton();
                                if (!proceedClicked) break;
                                const cartResult = await this._interceptAddToCartResponse();
                                if (!cartResult) break;
                                const action = this._classifyCartResponse(cartResult);
                                if (action === 'success') {
                                    const seatLabels = seatsToClick.map(s => `${s.row}${s.seat_No}`);
                                    logger.info(`${this.tag} 🎫 Tickets added to cart! Seats: ${seatLabels.join(', ')}`);
                                    await this._waitForModalClose(5000);
                                    await this.browser.takeScreenshot(`tickets_in_cart_${this.account.id}.png`);
                                    await this.telegram.sendTicketsAdded(standName, seatLabels, this.account.id);
                                    try {
                                        const checkoutResult = await this.checkoutFlow.runFromCurrentPage();
                                        if (checkoutResult === 'success' || checkoutResult === 'timeout') {
                                            await this.telegram.sendCheckoutReached(this.account.id);
                                            return true;
                                        }
                                        return false;
                                    } catch (error) {
                                        logger.error(`${this.tag} Checkout flow error: ${error.message}`);
                                        return true;
                                    }
                                }
                                if (action === 'retry_new_seats') {
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                    await this.browser.page.waitForTimeout(400);
                                    continue;
                                }
                                break; // Any other error — break out and proceed normally
                            }
                            // If we used the leftover modal, close it and continue to the current stand
                            if (usedLeftoverModal) {
                                if (await this._isSeatModalOpen()) {
                                    await this._closeSeatModal();
                                    await this._waitForModalClose(3000);
                                }
                                interceptor.reset();
                                continue; // Skip to next stand iteration (don't re-click this stand)
                            }
                        }
                    }
                    // No usable seats in leftover modal — close it normally
                    logger.info(`${this.tag} Seat modal still open from previous attempt — closing it`);
                    await this._closeSeatModal();
                    await this._waitForModalClose(3000);
                }

                // Now reset interceptor data for the new stand attempt.
                // This must happen AFTER the leftover modal check (which needs the old data)
                // but BEFORE the stand click (so fresh data is captured cleanly).
                interceptor.reset();

                // Set the timestamp BEFORE the click so that any API responses triggered
                // by the click (or pre-fetched by React Query during page load) are accepted.
                // The interceptor.reset() above already cleared stale data from previous stands,
                // so any data captured from this point forward belongs to this stand attempt.
                const standAttemptStartedAt = Date.now();

                // Click the stand in the UI
                const standClicked = await this._clickStand(standName);
                if (!standClicked) {
                    logger.warn(`${this.tag} Stand "${standName}" not found or not clickable, trying next`);
                    continue;
                }

                // Wait for seat data from interceptor (seat-template + seatlist)
                // The API fires as soon as the stand is clicked.
                const dataReady = await interceptor.waitForSeatData(
                    config.timeouts.seatDataInterceptMs,
                    standAttemptStartedAt
                );
                if (!dataReady) {
                    logger.warn(`${this.tag} Seat data not intercepted for stand "${standName}"`);
                    continue;
                }

                // Quick-check: if the intercepted seatlist has 0 available seats for our pool,
                // the website won't open the seat modal at all (just shows a toast).
                // Skip the 8-second modal wait in this case.
                {
                    const quickData = interceptor.getData();
                    const quickList = quickData?.seatList?.result || [];
                    const quickOpen = quickList.filter(s => s.status === 'O');
                    const quickAvail = quickOpen.filter(s => s.bucket === config.seats.pool);

                    // Debug: log seat availability breakdown
                    if (quickOpen.length > 0 && quickAvail.length === 0) {
                        const bucketCounts = {};
                        quickOpen.forEach(s => { bucketCounts[s.bucket] = (bucketCounts[s.bucket] || 0) + 1; });
                        logger.debug(`${this.tag} [DEBUG] Seats with status=O but wrong pool: ${JSON.stringify(bucketCounts)} (our pool="${config.seats.pool}")`);
                    }
                    logger.debug(`${this.tag} [DEBUG] Quick-check for "${standName}": total=${quickList.length}, open=${quickOpen.length}, pool-match=${quickAvail.length}, pool="${config.seats.pool}"`);

                    if (quickAvail.length === 0) {
                        // Don't skip entirely — the website may use fresher data or different
                        // filtering. Use a short modal wait (2s) instead of the full 8s.
                        // If the modal opens, we'll use it; if not, we move on quickly.
                        logger.warn(`${this.tag} No available seats in intercepted data for "${standName}" — using short modal wait (${quickOpen.length} open seats in other pools)`);
                        const quickModalOpen = await this._waitForSeatModal(2000);
                        if (!quickModalOpen) {
                            continue; // Modal didn't open — truly no seats, move to next stand
                        }
                        // Modal opened despite quick-check saying 0 seats — website has fresher data
                        logger.info(`${this.tag} Modal opened for "${standName}" despite quick-check (website has fresher seat data)`);
                    } else {
                        logger.info(`${this.tag} Found ${quickAvail.length} available seats for pool "${config.seats.pool}" in "${standName}"`);
                    }
                }

                // For seat-selection stands, the modal opens automatically after clicking.
                // Wait for the seat modal to appear with a canvas inside it (if not already open from quick-check path).
                const seatModalOpen = await this._isSeatModalOpen() || await this._waitForSeatModal();
                if (!seatModalOpen) {
                    logger.warn(`${this.tag} Seat modal did not open for stand "${standName}"; skipping`);
                    if (this.browser.konvaInterceptor) {
                        this.browser.konvaInterceptor.reset();
                    }
                    continue;
                }
                logger.info(`${this.tag} Seat selection modal opened for stand "${standName}"`);

                // Wait for the website's React to process the seatlist response and
                // render the Konva canvas nodes before we read/modify the stage.
                // The modal is freshly created each time (scale resets to 0.65) and
                // React Query's useEffect needs time to merge seatlist into template.
                // 400ms is sufficient — React useEffect fires within 1-2 frames (~32ms),
                // plus margin for data processing and Konva node updates.
                await this.browser.page.waitForTimeout(400);

                // Phase 5: Seat selection retry loop (within same stand)
                const seatRetryDeadline = Date.now() + (config.timeouts.seatRetryMinutes * 60 * 1000);
                let seatAttemptInStand = 0;

                while (Date.now() < seatRetryDeadline && this.hasTimeLeft()) {
                    seatAttemptInStand++;
                    const data = interceptor.getData();
                    const resolver = new KonvaSeatMapResolver({pool: config.seats.pool});
                    const browserZoom = this.browser.getZoomLevel();

                    // Set Konva scale on first attempt (zoom out to fit all seats)
                    if (seatAttemptInStand === 1) {
                        await resolver.setKonvaStageScale(this.browser.page, 0.3);
                        await this.browser.page.waitForTimeout(400);
                    }

                    // --- API-based seat resolution (kept for comparison logging, no scale change) ---
                    const browserSeats = await resolver.resolveWithBrowserCoords(
                        data.seatTemplate, data.seatList, this.browser.page, browserZoom,
                        false  // Scale already set above — don't set again
                    );

                    // --- Canvas-based seat reading (used for actual clicking) ---
                    const canvasResult = await resolver.readSeatsFromCanvas(this.browser.page, browserZoom);
                    const canvasAvail = (canvasResult.canvasSeats || []).filter(s => !s.selected);

                    // Log comparison between API intercept and canvas read
                    logger.info(`${this.tag} [COMPARE] API intercept: ${browserSeats.length} seats | Canvas read: ${canvasAvail.length} seats | Delta: ${canvasAvail.length - browserSeats.length}`);
                    if (browserSeats.length !== canvasAvail.length) {
                        logger.warn(`${this.tag} [COMPARE] ⚠️ MISMATCH! API says ${browserSeats.length}, canvas shows ${canvasAvail.length} available seats`);
                    }

                    if (canvasAvail.length === 0) {
                        logger.warn(`${this.tag} No available seats on canvas for stand "${standName}" (API says ${browserSeats.length})`);
                        break; // Try next stand
                    }

                    // Find consecutive seats from canvas data (uses konvaX spacing, not seat numbers)
                    const consecutiveCanvasSeats = resolver.findConsecutiveCanvasSeats(canvasResult.canvasSeats, seatCount);
                    if (!consecutiveCanvasSeats) {
                        logger.warn(`${this.tag} No ${seatCount} consecutive seats on canvas for stand "${standName}"`);
                        break; // Try next stand
                    }

                    logger.info(`${this.tag} Clicking ${seatCount} seats (canvas coords): ${consecutiveCanvasSeats.map(s =>
                        `konva(${s.konvaX},${s.konvaY})@browser(${Math.round(s.browserX)},${Math.round(s.browserY)})`).join(', ')}`);

                    // Click each seat using canvas-read browser coordinates
                    for (const seat of consecutiveCanvasSeats) {
                        await this.browser.showClickMarker(
                            seat.browserX,
                            seat.browserY,
                            `(${seat.konvaX},${seat.konvaY})`
                        );
                        await this.browser.page.waitForTimeout(150);
                        await this.browser.page.mouse.click(seat.browserX, seat.browserY);
                        logger.info(`${this.tag} Clicked seat at konva(${seat.konvaX},${seat.konvaY}) → browser(${seat.browserX.toFixed(1)},${seat.browserY.toFixed(1)})`);
                        await this.browser.page.waitForTimeout(150);
                    }

                    // Click "Proceed" button inside the seat modal
                    const proceedClicked = await this._clickProceedButton();
                    if (!proceedClicked) {
                        logger.warn(`${this.tag} Proceed button not found after seat selection — closing modal`);
                        await this._closeSeatModal();
                        await this._waitForModalClose(3000);
                        break; // Exit seat retry, try next stand
                    }

                    // Intercept ticketaddtocart response
                    const cartResult = await this._interceptAddToCartResponse();

                    if (!cartResult) {
                        logger.warn(`${this.tag} No add-to-cart response intercepted — closing modal`);
                        await this._closeSeatModal();
                        await this._waitForModalClose(3000);
                        break; // Exit seat retry, try next stand
                    }

                    // Handle response
                    const action = this._classifyCartResponse(cartResult);

                    if (action === 'success') {
                        const seatLabels = consecutiveCanvasSeats.map(s => `konva(${s.konvaX},${s.konvaY})`);
                        logger.info(`${this.tag} 🎫 Tickets added to cart! Stand: ${standName}, Seats: ${seatLabels.join(', ')}`);

                        // On success, the website closes the modal and navigates to checkout/addon.
                        // Wait for the modal to close before proceeding.
                        await this._waitForModalClose(5000);
                        await this.browser.takeScreenshot(`tickets_in_cart_${this.account.id}.png`);
                        await this.telegram.sendTicketsAdded(standName, seatLabels, this.account.id);

                        // Phase 7: Addon + Checkout
                        try {
                            const checkoutResult = await this.checkoutFlow.runFromCurrentPage();
                            if (checkoutResult === 'success' || checkoutResult === 'timeout') {
                                await this.telegram.sendCheckoutReached(this.account.id);
                                return true;
                            }
                            return false;
                        } catch (error) {
                            logger.error(`${this.tag} Checkout flow error: ${error.message}`);
                            await this.telegram.sendError(error.message, `Checkout error for ${this.account.id}`);
                            // Even if checkout flow throws, tickets are in cart — that's a partial success
                            return true;
                        }
                    }

                    if (action === 'retry_new_seats') {
                        const retryStartedAt = Date.now();
                        logger.info(`${this.tag} Seats taken by another user — waiting for fresh seatlist before retrying`);
                        // The modal stays open, the website automatically refetches the seatlist.
                        // Do NOT reset the interceptor — the seat-template hasn't changed.
                        // Wait for a fresh seatlist response captured AFTER this retry started.
                        // Website's j.refetch() fires immediately; network round-trip is ~200-500ms.
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        // Verify we have data captured after the retry started (not stale from before)
                        if (interceptor.lastSeatDataAt < retryStartedAt) {
                            logger.debug(`${this.tag} [DEBUG] Seatlist data is stale (captured ${retryStartedAt - interceptor.lastSeatDataAt}ms before retry). Waiting for fresh data...`);
                            // Wait up to 3 more seconds for fresh seatlist
                            const freshDeadline = Date.now() + 3000;
                            while (Date.now() < freshDeadline && interceptor.lastSeatDataAt < retryStartedAt) {
                                await new Promise(resolve => setTimeout(resolve, 300));
                            }
                            if (interceptor.lastSeatDataAt >= retryStartedAt) {
                                logger.info(`${this.tag} Fresh seatlist captured for retry`);
                            } else {
                                logger.warn(`${this.tag} No fresh seatlist arrived — using existing data`);
                            }
                        } else {
                            logger.info(`${this.tag} Fresh seatlist already available for retry (captured ${interceptor.lastSeatDataAt - retryStartedAt}ms after retry start)`);
                        }

                        // Wait for the website's React to process the fresh seatlist and
                        // re-render the Konva canvas nodes. The interceptor has the new data,
                        // but the canvas may still be showing the old seat states until React's
                        // useEffect fires and updates the Konva nodes.
                        await this.browser.page.waitForTimeout(400);

                        continue; // Retry within same stand (modal stays open)
                    }

                    if (action === 'retry_next_stand') {
                        logger.warn(`${this.tag} Stand limit exceeded for "${standName}" — closing modal, trying next stand`);
                        // The website may close the modal on stand-level errors, but ensure it's closed
                        await this._closeSeatModal();
                        await this._waitForModalClose(3000);
                        break; // Break inner loop, continue outer stand loop
                    }

                    if (action === 'hard_stop') {
                        logger.error(`${this.tag} 🛑 Hard limit reached: ${cartResult.message}. Cannot proceed.`);
                        await this.browser.takeScreenshot(`hard_limit_reached_${this.account.id}.png`);
                        await this.telegram.sendHardStop(this.account.id, cartResult.message);
                        return false;
                    }

                    // Unknown error — close modal and retry with next stand
                    logger.warn(`${this.tag} Unknown cart response: ${JSON.stringify(cartResult)} — closing modal`);
                    await this._closeSeatModal();
                    await this._waitForModalClose(3000);
                    break; // Try next stand instead of retrying same seats
                }

                // Ensure modal is closed before moving to next stand
                if (await this._isSeatModalOpen()) {
                    logger.info(`${this.tag} Closing seat modal before next stand`);
                    await this._closeSeatModal();
                    await this._waitForModalClose(3000);
                }

                // Reset interceptor data for next stand
                if (this.browser.konvaInterceptor) {
                    this.browser.konvaInterceptor.reset();
                }
            }

            // All stands tried in this round — loop back to first stand
            logger.info(`${this.tag} All ${standPriority.length} stands tried in round ${roundNumber}, looping back...`);
        }


        logger.warn(`${this.tag} Global timeout reached after all stand rotation rounds`);
        await this.browser.takeScreenshot(`timeout_all_rounds_${this.account.id}.png`);
        await this.telegram.sendTimeout(this.account.id);
        return false;
    }

    // ── UI Interaction Helpers (fast, event-driven) ─────────────────────

    async _dismissContinuePopup() {
        try {
            const btn = await this.browser.waitForAnyVisible([
                "button:has-text('Continue')",
                "button:has-text('Proceed')"
            ], 2000, 200);
            if (btn) {
                await btn.click();
                logger.info(`${this.tag} Dismissed Continue popup`);
            }
        } catch (_) {
        }
    }

    async _waitForTicketsLive() {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            try {
                const categoryFound = await this.browser.page.locator("xpath=//p[text()='CATEGORY']").count();
                if (categoryFound > 0) return true;

                const standFound = await this.browser.page.locator("text=/Stand/i").count();
                if (standFound > 0) return true;
            } catch (_) {
            }
            await this.browser.page.waitForTimeout(500);
        }
        return false;
    }

    async _clickStand(standName) {
        try {
            // Use the exact XPath from the website's UI structure
            const standLocators = await this.browser.page.locator(
                "xpath=//p[text()='CATEGORY']/following-sibling::div[1]/div/div/p[1]"
            ).all();

            // Debug: log all visible stands on the page
            const allStandNames = [];
            for (const loc of standLocators) {
                try {
                    const t = ((await loc.textContent()) || '').trim();
                    if (t) allStandNames.push(t);
                } catch (_) {}
            }
            if (allStandNames.length === 0) {
                logger.debug(`${this.tag} [DEBUG] No stands found with CATEGORY XPath. Page may not be ready or UI structure changed.`);
            } else {
                logger.debug(`${this.tag} [DEBUG] Stands on page (${allStandNames.length}): ${allStandNames.map(n => `"${n}"`).join(', ')}`);
            }

            for (let i = standLocators.length - 1; i >= 0; i--) {
                const text = ((await standLocators[i].textContent()) || '').trim();
                if (text.toLowerCase().includes(standName.toLowerCase())) {
                    await standLocators[i].click();
                    logger.info(`${this.tag} Clicked stand: "${text}"`);
                    return true;
                }
            }

            logger.debug(`${this.tag} [DEBUG] Stand "${standName}" not found in visible stands. Check STAND_PRIORITY matches exact stand names.`);
        } catch (error) {
            logger.warn(`${this.tag} Stand click failed: ${error.message}`);
        }
        return false;
    }

    async _selectTicketCount(count) {
        try {
            const section = this.browser.page.locator(
                "xpath=//p[text()='How many tickets?']/following-sibling::div[2]"
            ).first();
            const buttons = await section.locator('button').all();

            for (const button of buttons) {
                const text = ((await button.textContent()) || '').trim();
                if (text === String(count)) {
                    await button.click();
                    logger.info(`${this.tag} Selected ${count} tickets`);
                    return true;
                }
            }
        } catch (_) {
        }
        return false;
    }

    async _clickContinueButton() {
        try {
            // No CSS zoom — seat selection uses Konva slider zoom instead
            const btn = await this.browser.waitForAnyVisible([
                "button:has-text('Continue')",
                "button:has-text('Proceed')",
                "button:has-text('Next')"
            ], 3000, 200);
            if (btn) {
                await btn.click();
                return true;
            }
        } catch (_) {
        }
        return false;
    }

    /**
     * Wait for the seat selection modal to open with a canvas inside it.
     * This specifically waits for a modal dialog containing a Konva canvas,
     * NOT just any canvas on the page (the stand map also has a canvas).
     */
    async _waitForSeatModal(timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // Check for a modal/dialog that contains a canvas
                const modalCanvas = this.browser.page.locator(
                    '.chakra-modal__body .konvajs-content canvas, ' +
                    '.chakra-modal__content .konvajs-content canvas, ' +
                    '[role="dialog"] .konvajs-content canvas, ' +
                    '.chakra-modal__body canvas'
                ).first();
                if (await modalCanvas.isVisible()) {
                    const box = await modalCanvas.boundingBox();
                    if (box && box.width > 50 && box.height > 50) {
                        return true;
                    }
                }
            } catch (_) {}
            await this.browser.page.waitForTimeout(300);
        }
        return false;
    }

    async _clickProceedButton() {
        try {
            const btn = await this.browser.waitForAnyVisible([
                "button:has-text('Proceed')",
                "button:has-text('Continue')",
                "button:has-text('Confirm')",
                "button:has-text('Add to Cart')"
            ], 5000, 200);
            if (btn) {
                await btn.click();
                logger.info(`${this.tag} Clicked Proceed button`);
                return true;
            }
        } catch (_) {
        }
        return false;
    }

    /**
     * Close the seat selection modal if it's still open.
     * Tries the close button (X), then Escape key as fallback.
     */
    async _closeSeatModal() {
        try {
            // Try clicking the modal close button (Chakra UI close button)
            const closeBtn = await this.browser.waitForAnyVisible([
                '.chakra-modal__close-btn',
                '[aria-label="Close"]',
                'button.chakra-modal__close-btn'
            ], 1500, 200);
            if (closeBtn) {
                await closeBtn.click();
                logger.info(`${this.tag} Closed seat selection modal via close button`);
                await this.browser.page.waitForTimeout(500);
                return true;
            }
        } catch (_) {}

        // Fallback: press Escape
        try {
            await this.browser.page.keyboard.press('Escape');
            logger.info(`${this.tag} Pressed Escape to close modal`);
            await this.browser.page.waitForTimeout(500);
            return true;
        } catch (_) {}

        return false;
    }

    /**
     * Wait for the seat selection modal to close (disappear from DOM).
     * Returns true if modal closed, false if still open after timeout.
     */
    async _waitForModalClose(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const modalVisible = await this.browser.page.locator(
                    '.chakra-modal__content, [role="dialog"]'
                ).first().isVisible();
                if (!modalVisible) {
                    logger.info(`${this.tag} Seat modal closed`);
                    return true;
                }
            } catch (_) {
                // Element not found = modal closed
                return true;
            }
            await this.browser.page.waitForTimeout(300);
        }
        logger.warn(`${this.tag} Seat modal still open after ${timeoutMs}ms`);
        return false;
    }

    /**
     * Check if the seat selection modal is currently visible.
     */
    async _isSeatModalOpen() {
        try {
            const modal = this.browser.page.locator('.chakra-modal__content, [role="dialog"]').first();
            return await modal.isVisible();
        } catch (_) {
            return false;
        }
    }

    /**
     * Intercept the ticketaddtocart API response using page.waitForResponse.
     * This is event-driven — no polling, no unnecessary waits.
     */
    async _interceptAddToCartResponse() {
        try {
            const response = await this.browser.page.waitForResponse(
                r => r.url().includes('checkout/ticketaddtocart'),
                {timeout: config.timeouts.addToCartMs}
            );

            const data = await response.json();
            logger.info(`${this.tag} Add-to-cart response: status="${data.status}", message="${data.message || ''}"`);
            return data;
        } catch (error) {
            logger.warn(`${this.tag} Add-to-cart response intercept failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Classify the ticketaddtocart response into an action.
     */
    _classifyCartResponse(response) {
        if (!response) return 'unknown';

        if (response.status === 'Success') return 'success';

        const msg = (response.message || '').toUpperCase();

        if (config.cartErrors.retryNewSeats.some(e => msg.includes(e))) return 'retry_new_seats';
        if (config.cartErrors.retryNextStand.some(e => msg.includes(e))) return 'retry_next_stand';
        if (config.cartErrors.hardStop.some(e => msg.includes(e))) return 'hard_stop';

        return 'unknown';
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    async cleanup() {
        logger.info(`${this.tag} Cleaning up...`);
        try {
            if (this.browser) {
                await this.browser.stopKonvaInterceptor();
                await this.browser.stopNetworkCapture();
                // Don't close browser — leave it open for manual payment
                logger.info(`${this.tag} Browser left open for manual interaction`);
            }
        } catch (error) {
            logger.error(`${this.tag} Cleanup error: ${error.message}`);
        }
    }

    async closeBrowser() {
        try {
            if (this.browser) {
                await this.browser.close();
                logger.info(`${this.tag} Browser closed`);
            }
        } catch (error) {
            logger.error(`${this.tag} Browser close error: ${error.message}`);
        }
    }
}

// ── Entry Point — Parallel Multi-Account Launcher ───────────────────

async function main() {
    const enabledAccounts = (config.accounts || []).filter(a => a.enabled !== false);

    if (enabledAccounts.length === 0) {
        logger.error('❌ No enabled accounts found in config. Exiting.');
        process.exit(1);
    }

    logger.info(`🚀 Launching ${enabledAccounts.length} parallel session(s): ${enabledAccounts.map(a => a.id).join(', ')}`);
    logger.info(`🛰 Shared-event mode enabled: preload all accounts, poll eventlist with scout account only, then broadcast event to all accounts`);

    // Send Telegram startup notification
    await telegram.sendStartup(
        enabledAccounts.map(a => a.id),
        config.match.displayName,
        config.seats.standPriority
    );

    // Create one TicketAutomationSystem per enabled account
    const systems = enabledAccounts.map((account, index) =>
        new TicketAutomationSystem(account, index + 1)
    );

    // Graceful shutdown — cleanup all systems
    const shutdownAll = async () => {
        logger.info('Shutting down all sessions...');
        await Promise.allSettled(systems.map(s => s.cleanup()));
    };

    process.on('SIGINT', () => {
        logger.info('Received SIGINT — force shutting down all sessions...');
        shutdownAll().catch(() => {
        }).finally(() => {
            process.exit(0);
        });
        setTimeout(() => {
            logger.warn('Force exit after timeout');
            process.exit(1);
        }, 5000).unref();
    });

    process.on('SIGTERM', () => {
        logger.info('Received SIGTERM — force shutting down all sessions...');
        shutdownAll().catch(() => {
        }).finally(() => {
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000).unref();
    });

    process.on('unhandledRejection', (reason) => {
        logger.error(`Unhandled Rejection: ${reason}`);
    });

    process.on('uncaughtException', (error) => {
        logger.error(`Uncaught Exception: ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    });

    try {
        // Phase A: preload/login all accounts first
        logger.info('Phase A: Preloading all accounts and restoring login state before event polling...');
        const preloadResults = await Promise.allSettled(
            systems.map(system => system.preload())
        );

        const readySystems = [];
        const preloadFailures = [];

        preloadResults.forEach((result, index) => {
            const system = systems[index];
            const account = enabledAccounts[index];

            if (result.status === 'fulfilled' && result.value === true) {
                readySystems.push(system);
                logger.info(`✅ [${account.id}] Preload/login completed`);
            } else {
                const reason = result.status === 'rejected' ? result.reason?.message : 'preload/login failed';
                preloadFailures.push(account.id);
                logger.warn(`❌ [${account.id}] Preload/login failed: ${reason}`);
            }
        });

        if (readySystems.length === 0) {
            logger.error('❌ No accounts are ready after preload/login. Exiting.');
            await Promise.allSettled(systems.map(s => s.closeBrowser()));
            process.exit(1);
        }

        // Phase B: scout account polls eventlist once for all accounts
        const scoutSystem = readySystems[0];
        logger.info(`${scoutSystem.tag} 🛰 Selected as scout account for single eventlist polling`);

        const sharedEvent = await scoutSystem.discoverEvent();
        if (!sharedEvent) {
            logger.error(`${scoutSystem.tag} ❌ Scout account could not discover target event`);
            await telegram.sendMessage(`⏰ *Shared Event Discovery Failed*\n\nScout account: ${scoutSystem.account.id}\nTarget "${config.match.displayName}" not found within polling window.`);
            await Promise.allSettled(systems.map(s => s.closeBrowser()));
            process.exit(1);
        }

        logger.info(`📣 Shared event discovered by scout: ${sharedEvent.event_Name} (${sharedEvent.event_Code}) — broadcasting to ${readySystems.length} ready account(s)`);
        await telegram.sendMessage(`📣 *Shared Event Discovered*\n\nScout: ${scoutSystem.account.id}\nEvent: ${sharedEvent.event_Name}\nCode: ${sharedEvent.event_Code}\nReady accounts: ${readySystems.map(s => s.account.id).join(', ')}`);

        // Phase C: all ready accounts jump directly into booking using the shared event
        await Promise.allSettled(
            readySystems.map(system => system.checkLogin())
        );
        const bookingResults = await Promise.allSettled(
            readySystems.map(system => system.startWithKnownEvent(sharedEvent))
        );

        // Summarize results
        const successes = [];
        const failures = [...preloadFailures];

        bookingResults.forEach((result, index) => {
            const system = readySystems[index];
            const account = system.account;
            if (result.status === 'fulfilled' && result.value === true) {
                successes.push(account.id);
                logger.info(`✅ [${account.id}] Booking succeeded!`);
            } else {
                failures.push(account.id);
                const reason = result.status === 'rejected' ? result.reason?.message : 'no tickets booked';
                logger.warn(`❌ [${account.id}] Booking failed: ${reason}`);
            }
        });

        logger.info(`\n${'═'.repeat(60)}`);
        logger.info(`📊 PARALLEL RESULTS: ${successes.length} succeeded, ${failures.length} failed`);
        if (successes.length > 0) logger.info(`   ✅ Success: ${successes.join(', ')}`);
        if (failures.length > 0) logger.info(`   ❌ Failed:  ${failures.join(', ')}`);
        logger.info(`${'═'.repeat(60)}\n`);

        // Send Telegram summary
        await telegram.sendSummary(successes, failures);

        if (successes.length > 0) {
            logger.info('🎉 At least one account booked successfully!');
            logger.info('Process will stay alive for payment. Press Ctrl+C to exit.');

            // Close browsers for failed accounts to free resources
            for (const system of systems) {
                if (!successes.includes(system.account.id)) {
                    await system.closeBrowser();
                }
            }
        } else {
            logger.warn('No accounts succeeded. Cleaning up all browsers...');
            await Promise.allSettled(systems.map(s => s.closeBrowser()));
            process.exit(1);
        }
    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        logger.error(error.stack);
        await Promise.allSettled(systems.map(s => s.cleanup()));
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = TicketAutomationSystem;
