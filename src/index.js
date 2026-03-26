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
        logger.info(`${this.tag} Target: ${config.match.displayName} | Stands: ${config.seats.standPriority.join(' → ')}`);
        logger.info(`${this.tag} Browser zoom: ${config.browser.zoomLevel * 100}% | Seats needed: ${config.seats.requiredConsecutiveSeats}`);

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

    // ── Phase 1: Initialize + Login ─────────────────────────────────────

    async initializeAndLogin() {
        logger.info(`${this.tag} Phase 1: Initializing browser and authenticating...`);

        this.browser = new BrowserManager(this.sessionId, this.account);
        const initialized = await this.browser.initialize();
        if (!initialized) return false;

        // Navigate to website
        const navigated = await this.browser.navigateToWebsite();
        if (!navigated) return false;

        // Apply zoom immediately after page loads
        await this.browser.applyZoom();

        // Start network capture
        await this.browser.startNetworkCapture();

        // Login (session reuse or OTP)
        this.login = new LoginManager(this.browser, this.account);
        await this.telegram.sendLoginRequired(this.account.id);
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
        await this.telegram.sendMatchFound(`Event: ${event.event_Name}\nCode: ${event.event_Code}\nAccount: ${this.account.id}`);
        return event;
    }

    // ── Phase 3-7: Booking Flow ─────────────────────────────────────────

    async executeBookingFlow(event) {
        const ticketUrl = this.matchDetector.getTicketPageUrl(event);
        logger.info(`${this.tag} Phase 3: Navigating to ticket page: ${ticketUrl}`);

        // Navigate to event page
        const navigated = await this.browser.navigateFast(ticketUrl);
        if (!navigated) {
            logger.error(`${this.tag} Failed to navigate to ticket page`);
            return false;
        }

        // Apply 50% zoom so entire stand view fits on screen
        await this.browser.applyZoom();

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
            await this.browser.applyZoom();
            await this._dismissContinuePopup();
        }

        logger.info(`${this.tag} ✅ Phase 3 complete: On ticket page, zoom applied, interceptor active`);

        // Phase 4-6: Stand selection → Seat selection → Add to cart (with retry)
        return await this._standAndSeatLoop(event);
    }

    /**
     * Main retry loop: try each stand in priority order.
     * Within each stand, retry seat selection if seats are taken.
     * Handles all ticketaddtocart response codes.
     */
    async _standAndSeatLoop(event) {
        const standPriority = config.seats.standPriority;
        const seatCount = config.seats.requiredConsecutiveSeats;
        let roundNumber = 0;

        // Loop through all stands continuously until global timeout
        while (this.hasTimeLeft()) {
            roundNumber++;
            logger.info(`${this.tag} Stand rotation round ${roundNumber} (${Math.ceil(this.remainingMs() / 1000)}s remaining)`);

            for (let standIdx = 0; standIdx < standPriority.length && this.hasTimeLeft(); standIdx++) {
                const standName = standPriority[standIdx];
                logger.info(`${this.tag} Phase 4: Trying stand "${standName}" (${standIdx + 1}/${standPriority.length})`);

                // Click the stand in the UI
                const standClicked = await this._clickStand(standName);
                if (!standClicked) {
                    logger.warn(`${this.tag} Stand "${standName}" not found or not clickable, trying next`);
                    continue;
                }

                // Select ticket count
                await this._selectTicketCount(seatCount);

                // Click Continue to open seat map
                await this._clickContinueButton();

                // Wait for seat data from interceptor (seat-template + seatlist)
                const interceptor = this.browser.konvaInterceptor;
                if (!interceptor) {
                    logger.error(`${this.tag} Konva interceptor not available`);
                    continue;
                }

                const dataReady = await interceptor.waitForSeatData(config.timeouts.seatDataInterceptMs);
                if (!dataReady) {
                    logger.warn(`${this.tag} Seat data not intercepted for stand "${standName}"`);
                    continue;
                }

                // Phase 5: Seat selection retry loop (within same stand)
                const seatRetryDeadline = Date.now() + (config.timeouts.seatRetryMinutes * 60 * 1000);

                while (Date.now() < seatRetryDeadline && this.hasTimeLeft()) {
                    const data = interceptor.getData();
                    const resolver = new KonvaSeatMapResolver({pool: config.seats.pool});
                    const browserZoom = this.browser.getZoomLevel();

                    const browserSeats = await resolver.resolveWithBrowserCoords(
                        data.seatTemplate, data.seatList, this.browser.page, browserZoom
                    );

                    if (browserSeats.length === 0) {
                        logger.warn(`${this.tag} No available seats in stand "${standName}"`);
                        break; // Try next stand
                    }

                    // Find consecutive seats
                    const consecutiveSeats = resolver.findConsecutiveSeats(seatCount);
                    if (!consecutiveSeats) {
                        logger.warn(`${this.tag} No ${seatCount} consecutive seats in stand "${standName}"`);
                        break; // Try next stand
                    }

                    // Convert to browser coords for clicking
                    const canvasState = await resolver.getCanvasState(this.browser.page);
                    if (!canvasState) {
                        logger.error(`${this.tag} Canvas not found on page`);
                        break;
                    }

                    const seatsToClick = consecutiveSeats.map(seat => {
                        const {browserX, browserY} = resolver.toBrowserCoords(
                            seat, canvasState.canvasRect, canvasState.scale, canvasState.stageOffset, browserZoom
                        );
                        return {...seat, browserX, browserY};
                    });

                    logger.info(`${this.tag} Clicking ${seatCount} seats: ${seatsToClick.map(s =>
                        `${s.row}${s.seat_No}@(${Math.round(s.browserX)},${Math.round(s.browserY)})`).join(', ')}`);

                    // Click each seat on the canvas
                    for (const seat of seatsToClick) {
                        await this.browser.page.mouse.click(seat.browserX, seat.browserY);
                        logger.info(`${this.tag} Clicked seat ${seat.row}${seat.seat_No}`);
                    }

                    // Click "Proceed" button
                    const proceedClicked = await this._clickProceedButton();
                    if (!proceedClicked) {
                        logger.warn(`${this.tag} Proceed button not found after seat selection`);
                        continue;
                    }

                    // Intercept ticketaddtocart response
                    const cartResult = await this._interceptAddToCartResponse();

                    if (!cartResult) {
                        logger.warn(`${this.tag} No add-to-cart response intercepted`);
                        continue;
                    }

                    // Handle response
                    const action = this._classifyCartResponse(cartResult);

                    if (action === 'success') {
                        const seatLabels = seatsToClick.map(s => `${s.row}${s.seat_No}`);
                        logger.info(`${this.tag} 🎫 Tickets added to cart! Stand: ${standName}, Seats: ${seatLabels.join(', ')}`);
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
                        logger.info(`${this.tag} Seats taken by another user — retrying with new seats in same stand`);
                        // Wait for seatlist to refresh (the app auto-refetches)
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        // Reset interceptor to capture fresh seatlist
                        interceptor.seatListData = null;
                        await interceptor.waitForSeatData(config.timeouts.seatDataInterceptMs);
                        continue; // Retry within same stand
                    }

                    if (action === 'retry_next_stand') {
                        logger.warn(`${this.tag} Stand limit exceeded for "${standName}" — trying next stand`);
                        break; // Break inner loop, continue outer stand loop
                    }

                    if (action === 'hard_stop') {
                        logger.error(`${this.tag} 🛑 Hard limit reached: ${cartResult.message}. Cannot proceed.`);
                        await this.browser.takeScreenshot(`hard_limit_reached_${this.account.id}.png`);
                        await this.telegram.sendHardStop(this.account.id, cartResult.message);
                        return false;
                    }

                    // Unknown error — retry
                    logger.warn(`${this.tag} Unknown cart response: ${JSON.stringify(cartResult)}. Retrying...`);
                    continue;
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

            for (let i = standLocators.length - 1; i >= 0; i--) {
                const text = ((await standLocators[i].textContent()) || '').trim();
                if (text.toLowerCase().includes(standName.toLowerCase())) {
                    await standLocators[i].click();
                    logger.info(`${this.tag} Clicked stand: "${text}"`);
                    return true;
                }
            }
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
        // Launch all accounts in parallel — each runs the full booking flow independently
        const results = await Promise.allSettled(
            systems.map(system => system.start())
        );

        // Summarize results
        const successes = [];
        const failures = [];

        results.forEach((result, index) => {
            const account = enabledAccounts[index];
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
            for (let i = 0; i < results.length; i++) {
                if (results[i].status !== 'fulfilled' || results[i].value !== true) {
                    await systems[i].closeBrowser();
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