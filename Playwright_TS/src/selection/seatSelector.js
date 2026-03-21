const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('SeatSelector');

class SeatSelector {
  constructor(browserManager, telegramNotifier) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
  }

  buildSeatSelectionResult(selectedPair, strategy) {
    return {
      success: true,
      pair: selectedPair,
      strategy,
      seatLabels: selectedPair.map(seat => `${seat.row}${seat.number}`),
      stand: selectedPair[0]?.stand || 'Unknown'
    };
  }

  async selectConsecutiveSeats(seatMap) {
    logger.info('Starting consecutive seat selection...');

    const preferredPairs = this.findPairsByStandPriority(seatMap.seats, config.seats.preferredStand);
    let selectedPair = preferredPairs[0] || null;

    if (!selectedPair) {
      const fallbackPairs = this.findPairsByStandPriority(seatMap.seats, config.seats.fallbackStand);
      selectedPair = fallbackPairs[0] || null;
    }

    if (!selectedPair) {
      logger.warn(`No 2 consecutive seats found in ${config.seats.preferredStand} or ${config.seats.fallbackStand}`);
      return null;
    }

    logger.info(`Selected pair: ${selectedPair[0].row}${selectedPair[0].number} & ${selectedPair[1].row}${selectedPair[1].number}`);
    
    const success = await this.selectSeats(selectedPair, seatMap.selectSeat);
    
    if (success) {
      await this.browser.takeScreenshot(`seats_selected_session${this.browser.sessionId}.png`);
      await this.verifySeatsInCart(selectedPair);
      
      const seatLabels = selectedPair.map(seat => `${seat.row}${seat.number}`);
      await this.telegram.sendTicketsAdded(
        selectedPair[0].stand || 'Unknown',
        seatLabels,
        this.browser.sessionId
      );
      
      return this.buildSeatSelectionResult(selectedPair, 'preferred-stand');
    }
    
    return null;
  }

  async runStandSeatFlow(selectedStand, seatMap = { seats: [], selectSeat: async () => false }) {
    const started = Date.now();
    const retryWindowMs = config.seats.retryOccupiedSeatMinutes * 60 * 1000;

    while (Date.now() - started < retryWindowMs) {
      const selectedPair = await this.selectPreferredPairForStand(seatMap, selectedStand);
      if (!selectedPair) {
        return { success: false, reason: `No 2 consecutive seats found in ${selectedStand}` };
      }

      const navigated = await this.retryUntilNextPage(selectedPair, seatMap.selectSeat);
      if (navigated) {
        return { success: true, stand: selectedStand, seats: selectedPair };
      }

      logger.warn(`Seat confirmation failed for ${selectedStand}; retrying with another pair`);
      await this.browser.page.waitForTimeout(1000);
    }

    return { success: false, reason: `Seat retry exhausted in ${selectedStand}` };
  }

  async selectPreferredPairForStand(seatMap, standName) {
    const standSeats = (seatMap.seats || []).filter(seat => seat.available && seat.stand && seat.stand.toLowerCase().includes(standName.toLowerCase()));
    const sameStandPairs = this.findConsecutivePairs(standSeats);
    return sameStandPairs[0] || null;
  }

  async retryUntilNextPage(seatPair, selectFunction) {
    const selected = await this.selectSeats(seatPair, selectFunction);
    if (!selected) return false;

    const nextClicked = await this.clickNextOrContinue();
    if (!nextClicked) return false;

    const movedForward = await this.detectNavigationAfterSeatConfirmation();
    return movedForward;
  }

  async clickNextOrContinue() {
    const nextBtn = await this.browser.firstVisible([
      "button:has-text('Next')",
      "button:has-text('Continue')",
      "button:has-text('Proceed')",
      "button:has-text('Confirm')",
      '.next-btn',
      '[class*="next"]'
    ]);

    if (!nextBtn) return false;
    await nextBtn.click();
    return true;
  }

  async detectNavigationAfterSeatConfirmation() {
    await this.browser.page.waitForTimeout(1500);
    const url = this.browser.page.url().toLowerCase();
    const text = ((await this.browser.page.locator('body').textContent()) || '').toLowerCase();
    const blocked = ['occupied', 'already booked', 'not available', 'selection failed'];
    if (blocked.some((msg) => text.includes(msg))) {
      return false;
    }
    return url.includes('cart') || url.includes('checkout') || text.includes('cart') || text.includes('summary');
  }

  findPairsByStandPriority(seats, standName) {
    const standSeats = (seats || []).filter(seat => {
      if (!seat.available) return false;
      if (!seat.stand) return false;
      return seat.stand.toLowerCase().includes((standName || '').toLowerCase());
    });

    return this.findConsecutivePairs(standSeats);
  }

  findConsecutivePairs(seats) {
    const seatsByRow = {};
    
    seats.forEach(seat => {
      const row = seat.row || 'unknown';
      if (!seatsByRow[row]) {
        seatsByRow[row] = [];
      }
      seatsByRow[row].push(seat);
    });
    
    const consecutivePairs = [];
    
    Object.keys(seatsByRow).forEach(row => {
      const rowSeats = seatsByRow[row]
        .map(seat => ({
          ...seat,
          number: parseInt(seat.number)
        }))
        .filter(seat => !isNaN(seat.number))
        .sort((a, b) => a.number - b.number);
      
      for (let i = 0; i < rowSeats.length - 1; i++) {
        const currentSeat = rowSeats[i];
        const nextSeat = rowSeats[i + 1];
        
        if (nextSeat.number === currentSeat.number + 1) {
          consecutivePairs.push([currentSeat, nextSeat]);
        }
      }
    });
    
    return consecutivePairs;
  }

  async selectSeats(seatPair, selectFunction) {
    try {
      logger.info(`Selecting first seat: ${seatPair[0].row}${seatPair[0].number}`);
      const firstSuccess = await selectFunction(seatPair[0]);
      
      if (!firstSuccess) {
        logger.error('Failed to select first seat');
        return false;
      }
      
      await this.browser.page.waitForTimeout(500);
      
      logger.info(`Selecting second seat: ${seatPair[1].row}${seatPair[1].number}`);
      const secondSuccess = await selectFunction(seatPair[1]);
      
      if (!secondSuccess) {
        logger.error('Failed to select second seat');
        return false;
      }
      
      logger.info('Both seats selected successfully');
      return true;
    } catch (error) {
      logger.error(`Error selecting seats: ${error.message}`);
      return false;
    }
  }

  async verifySeatsInCart(selectedPair) {
    try {
      await this.browser.page.waitForTimeout(2000);
      
      const cartIndicators = [
        '.cart-count',
        '.basket-count',
        '[data-testid="cart-count"]',
        '.selected-seats',
        '.seat-selection'
      ];
      
      for (const selector of cartIndicators) {
        try {
          const element = await this.browser.page.locator(selector).first();
          if (await element.isVisible()) {
            const text = await element.textContent();
            if (text && (text.includes('2') || text.includes('selected'))) {
              logger.info('Seats verified in cart');
              return true;
            }
          }
        } catch (error) {
          // Continue to next indicator
        }
      }
      
      logger.warn('Could not verify seats in cart');
      return false;
    } catch (error) {
      logger.error(`Error verifying seats in cart: ${error.message}`);
      return false;
    }
  }

  async waitForSeatSelection() {
    try {
      const selectionIndicators = [
        '.seat-selected',
        '.selected',
        '[data-selected="true"]',
        '.seat-active'
      ];
      
      for (const selector of selectionIndicators) {
        try {
          await this.browser.page.waitForSelector(selector, { timeout: 5000 });
          logger.info('Seat selection confirmed');
          return true;
        } catch (error) {
          // Continue to next indicator
        }
      }
      
      await this.browser.page.waitForTimeout(3000);
      return true;
    } catch (error) {
      logger.error(`Error waiting for seat selection: ${error.message}`);
      return false;
    }
  }
}

module.exports = SeatSelector;
