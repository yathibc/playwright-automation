const { createModuleLogger } = require('../utils/logger');
const config = require('../config/config');

const logger = createModuleLogger('MatchDetector');

class MatchDetector {
  constructor(browserManager, telegramNotifier) {
    this.browser = browserManager;
    this.telegram = telegramNotifier;
  }

  async searchForMatch() {
    logger.info('Starting match detection...');

    const matchFound = await this.findMatchContainer();
    
    if (matchFound) {
      logger.info('Target match detected');
      await this.telegram.sendMatchFound(matchFound.details);
      return await this.clickBookingButton(matchFound.container);
    }
    
    logger.info('Target match not found');
    return false;
  }

  async discoverMatchAvailability() {
    const found = await this.findMatchContainer();
    if (!found) {
      return { found: false, available: false, availableStands: [] };
    }

    const available = await this.hasBookingButton(found.container);
    const availableStands = await this.estimateAvailableStands();

    return {
      found: true,
      available,
      availableStands,
      details: found.details
    };
  }

  async estimateAvailableStands() {
    const pageText = (await this.browser.page.locator('body').textContent() || '').toLowerCase();
    const stands = [];
    if (pageText.includes(config.seats.preferredStand.toLowerCase())) stands.push(config.seats.preferredStand);
    if (pageText.includes(config.seats.fallbackStand.toLowerCase())) stands.push(config.seats.fallbackStand);
    return stands;
  }

  async findMatchContainer() {
    const { keywords } = config.match;

    const candidateSelectors = [
      "[data-match-id]",
      ".match-card",
      ".fixture",
      "[class*='match']",
      "[class*='fixture']",
      "article",
      "section",
      "li"
    ];

    for (const selector of candidateSelectors) {
      const allElements = await this.browser.page.locator(selector).all();
      for (const element of allElements) {
      try {
        const textContent = await element.textContent();
          const innerHTML = await element.innerHTML();
        
          if (!textContent || !textContent.trim()) continue;
        
          const hasTeam1 = keywords.team1.some(keyword => 
            textContent.toLowerCase().includes(keyword.toLowerCase()) ||
            innerHTML.toLowerCase().includes(keyword.toLowerCase())
          );
        
          const hasTeam2 = keywords.team2.some(keyword => 
            textContent.toLowerCase().includes(keyword.toLowerCase()) ||
            innerHTML.toLowerCase().includes(keyword.toLowerCase())
          );
        
          if (hasTeam1 && hasTeam2) {
            logger.info('Found container with both teams');
          
            const hasBookingButton = await this.hasBookingButton(element);
          
            if (hasBookingButton) {
              const details = await this.extractMatchDetails(element);
              return {
                container: element,
                details: details
              };
            }
          }
        } catch (error) {
          // Continue to next element
        }
      }
    }
    
    return null;
  }

  async hasBookingButton(container) {
    const bookingLabels = config.match.bookingButtonLabels;
    
    try {
      const containerHTML = await container.innerHTML();
      
      for (const label of bookingLabels) {
        if (containerHTML.toLowerCase().includes(label.toLowerCase())) {
          return true;
        }
      }
      
      const childElements = await container.locator('*').all();
      
      for (const child of childElements) {
        const childText = await child.textContent();
        const childHTML = await child.innerHTML();
        
        for (const label of bookingLabels) {
          if ((childText && childText.toLowerCase().includes(label.toLowerCase())) ||
              (childHTML && childHTML.toLowerCase().includes(label.toLowerCase()))) {
            return true;
          }
        }
      }
      
      return false;
    } catch (error) {
      logger.debug(`Error checking booking button: ${error.message}`);
      return false;
    }
  }

  async extractMatchDetails(container) {
    try {
      const textContent = await container.textContent();
      const innerHTML = await container.innerHTML();
      
      const details = {
        fullText: textContent.trim(),
        html: innerHTML
      };
      
      const team1Keywords = config.match.keywords.team1;
      const team2Keywords = config.match.keywords.team2;
      
      for (const keyword of team1Keywords) {
        if (textContent.toLowerCase().includes(keyword.toLowerCase())) {
          details.team1 = keyword;
          break;
        }
      }
      
      for (const keyword of team2Keywords) {
        if (textContent.toLowerCase().includes(keyword.toLowerCase())) {
          details.team2 = keyword;
          break;
        }
      }
      
      return details;
    } catch (error) {
      logger.error(`Error extracting match details: ${error.message}`);
      return { fullText: 'Unknown match' };
    }
  }

  async clickBookingButton(container) {
    const bookingLabels = config.match.bookingButtonLabels;
    
    try {
      const clickableSelectors = [
        'button',
        'a[href]',
        '.btn',
        '.button',
        '[role="button"]',
        '.clickable',
        'div[onclick]'
      ];
      
      for (const selector of clickableSelectors) {
        const elements = await container.locator(selector).all();
        
        for (const element of elements) {
          try {
            const textContent = await element.textContent();
            const innerHTML = await element.innerHTML();
            
            for (const label of bookingLabels) {
              if ((textContent && textContent.toLowerCase().includes(label.toLowerCase())) ||
                  (innerHTML && innerHTML.toLowerCase().includes(label.toLowerCase()))) {
                
                logger.info(`Found booking button: ${textContent || innerHTML}`);
                
                const isVisible = await element.isVisible();
                const isEnabled = await element.isEnabled();
                
                if (isVisible && isEnabled) {
                  await this.browser.takeScreenshot(`booking_button_found_session${this.browser.sessionId}.png`);
                  
                  const success = await element.click();
                  if (success) {
                    logger.info('Booking button clicked successfully');
                    await this.browser.waitForNavigation();
                    return true;
                  }
                }
              }
            }
          } catch (error) {
            // Continue to next element
          }
        }
      }
      
      const allClickable = await container.locator('*').all();
      for (const element of allClickable) {
        try {
          const textContent = await element.textContent();
          const innerHTML = await element.innerHTML();
          
          for (const label of bookingLabels) {
            if ((textContent && textContent.toLowerCase().includes(label.toLowerCase())) ||
                (innerHTML && innerHTML.toLowerCase().includes(label.toLowerCase()))) {
              
              const isVisible = await element.isVisible();
              const isEnabled = await element.isEnabled();
              
              if (isVisible && isEnabled) {
                await this.browser.takeScreenshot(`booking_button_clicked_session${this.browser.sessionId}.png`);
                await element.click();
                logger.info('Generic booking button clicked');
                await this.browser.waitForNavigation();
                return true;
              }
            }
          }
        } catch (error) {
          // Continue to next element
        }
      }
      
      logger.warn('No clickable booking button found');
      return false;
    } catch (error) {
      logger.error(`Error clicking booking button: ${error.message}`);
      return false;
    }
  }

  async monitorForMatch() {
    logger.info('Setting up match monitoring...');
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const matchFound = await this.searchForMatch();
        if (matchFound) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 2000);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(false);
      }, 300000); // 5 minute timeout
    });
  }

  async waitForMatchPage() {
    try {
      await this.browser.page.waitForLoadState('networkidle', {
        timeout: 30000
      });
      
      await this.browser.takeScreenshot(`match_page_loaded_session${this.browser.sessionId}.png`);
      logger.info('Match page loaded successfully');
      return true;
    } catch (error) {
      logger.error(`Error waiting for match page: ${error.message}`);
      return false;
    }
  }
}

module.exports = MatchDetector;
