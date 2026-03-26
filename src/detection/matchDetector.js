/**
 * MatchDetector — API-first event discovery
 *
 * Polls GET /ticket/eventlist/O to find the target match.
 * No browser navigation needed — uses the auth token extracted from cookies.
 * Falls back to UI-based detection only if API is unavailable.
 */
const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('MatchDetector');

class MatchDetector {
  constructor(browserManager) {
    this.browser = browserManager;
    this._authToken = null;
    this._discoveredEvent = null;  // Cached event data from API
  }

  /**
   * Get or refresh the auth token from browser cookies.
   */
  async _getAuthToken() {
    if (!this._authToken) {
      this._authToken = await this.browser.extractAuthToken();
    }
    return this._authToken;
  }

  /**
   * Call the event list API directly using Playwright's request context.
   * @returns {Array|null} Array of event objects or null on failure
   */
  async _fetchEventList() {
    try {
      const token = await this._getAuthToken();
      if (!token) {
        logger.warn('No auth token available for API call');
        return null;
      }

      const url = `${config.api.baseUrl}${config.api.eventListPath}`;
      const response = await this.browser.page.request.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: config.timeouts.apiResponseMs
      });

      if (!response.ok()) {
        logger.warn(`Event list API returned ${response.status()}`);
        return null;
      }

      const data = await response.json();
      if (data.status !== 'Success' || !Array.isArray(data.result)) {
        logger.warn(`Event list API unexpected response: ${data.status || 'unknown'}`);
        return null;
      }

      return data.result;
    } catch (error) {
      logger.warn(`Event list API call failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if an event matches our target match criteria.
   * Matches by team names in event_Name and button text.
   */
  _isTargetEvent(event) {
    const name = (event.event_Name || '').toLowerCase();
    const buttonText = (event.event_Button_Text || '').toUpperCase();

    const team1Match = config.match.targetTeam1.toLowerCase();
    const team2Match = config.match.targetTeam2.toLowerCase();
    const requiredButton = config.match.requiredButtonText.toUpperCase();

    // Event name must contain both team names
    const hasTeam1 = name.includes(team1Match) ||
      config.match.keywords.team1.some(kw => name.includes(kw.toLowerCase()));
    const hasTeam2 = name.includes(team2Match) ||
      config.match.keywords.team2.some(kw => name.includes(kw.toLowerCase()));

    // Button text must indicate tickets are available
    const hasButton = buttonText === requiredButton ||
        buttonText.includes('BUY') || buttonText.includes('TICKET');

    return hasTeam1 && hasTeam2 && hasButton;
  }

  /**
   * Poll the event list API until the target match is found or timeout.
   * Returns the event object or null.
   *
   * @param {number} deadlineTs - Absolute timestamp deadline (from global timeout)
   * @returns {Object|null} Event object { event_Code, event_Group_Code, event_Name, ... }
   */
  async pollForTargetEvent(deadlineTs = null) {
    const pollInterval = config.api.pollIntervalMs;
    const maxDuration = config.timeouts.eventPollMinutes * 60 * 1000;
    const deadline = deadlineTs || (Date.now() + maxDuration);

    logger.info(`Polling for target event: "${config.match.displayName}"
    (interval: ${pollInterval}ms, deadline: ${Math.ceil((deadline - Date.now()) / 1000)}s)`);

    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;

      const events = await this._fetchEventList();
      if (events) {
        const target = events.find(e => this._isTargetEvent(e));
        if (target) {
          this._discoveredEvent = target;
          logger.info(`🏏 Target event found after ${attempt} poll(s): "${target.event_Name}"
           (code: ${target.event_Code}, group: ${target.event_Group_Code})`);
          logger.info(`   Button: "${target.event_Button_Text}", Date: ${target.event_Display_Date},
           Price: ${target.event_Price_Range}`);
          return target;
        }

        if (attempt % 10 === 0) {
          const eventNames = events.map(e => `"${e.event_Name}" [${e.event_Button_Text}]`).join(', ');
          logger.info(`Poll #${attempt}: ${events.length} events found but none match target. Events: ${eventNames}`);
        }
      } else if (attempt % 5 === 0) {
        logger.info(`Poll #${attempt}: API returned no data, retrying...`);
      }

      // Wait before next poll — but check deadline first
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)));
    }

    logger.warn(`Target event not found within polling window (${attempt} attempts)`);
    return null;
  }

  /**
   * Get the cached discovered event (from last successful poll).
   */
  getDiscoveredEvent() {
    return this._discoveredEvent;
  }

  /**
   * Build the ticket page URL from the discovered event.
   * @returns {string} URL like https://shop.royalchallengers.com/ticket/{event_Code}
   */
  getTicketPageUrl(event = null) {
    const evt = event || this._discoveredEvent;
    if (!evt) return config.match.matchUrl;
    return `${config.website.url}/ticket/${evt.event_Code}`;
  }

  // ── Legacy UI-based methods (fallback) ──────────────────────────────

  async searchForMatch() {
    logger.info('Starting UI-based match detection (fallback)...');

    const matchFound = await this.findMatchContainer();

    if (matchFound) {
      logger.info(`🏏 Target match detected via UI: ${JSON.stringify(matchFound.details)}`);
      return await this.clickBookingButton(matchFound.container);
    }

    logger.info('Target match not found via UI');
    return false;
  }

  async findMatchContainer() {
    const { keywords } = config.match;

    const candidateSelectors = [
      "[data-match-id]", ".match-card", ".fixture",
      "[class*='match']", "[class*='fixture']", "article", "section", "li"
    ];

    for (const selector of candidateSelectors) {
      const allElements = await this.browser.page.locator(selector).all();
      for (const element of allElements) {
        try {
          const textContent = await element.textContent();
          if (!textContent || !textContent.trim()) continue;

          const hasTeam1 = keywords.team1.some(kw => textContent.toLowerCase().includes(kw.toLowerCase()));
          const hasTeam2 = keywords.team2.some(kw => textContent.toLowerCase().includes(kw.toLowerCase()));

          if (hasTeam1 && hasTeam2) {
            const hasBooking = await this.hasBookingButton(element);
            if (hasBooking) {
              return { container: element, details: { fullText: textContent.trim().substring(0, 200) } };
            }
          }
        } catch (_) {}
      }
    }

    return null;
  }

  async hasBookingButton(container) {
    try {
      const html = await container.innerHTML();
      return config.match.bookingButtonLabels.some(label => html.toLowerCase().includes(label.toLowerCase()));
    } catch (_) {
      return false;
    }
  }

  async clickBookingButton(container) {
    const bookingLabels = config.match.bookingButtonLabels;
    try {
      for (const selector of ['button', 'a[href]', '.btn', '[role="button"]']) {
        const elements = await container.locator(selector).all();
        for (const element of elements) {
          try {
            const text = await element.textContent();
            for (const label of bookingLabels) {
              if (text && text.toLowerCase().includes(label.toLowerCase())) {
                if (await element.isVisible() && await element.isEnabled()) {
                  await element.click();
                  logger.info('Booking button clicked via UI fallback');
                  return true;
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    return false;
  }
}

module.exports = MatchDetector;