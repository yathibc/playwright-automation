require('dotenv').config();
const { chromium } = require('playwright');

async function testBrowser() {

  console.log("Testing browser setup...");

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: null
  });

  const page = await context.newPage();

  await page.goto('https://www.royalchallengers.com/', {
    waitUntil: 'domcontentloaded'
  });

  await page.waitForLoadState('networkidle');

  console.log("Browser opened successfully");
  console.log("Window should be maximized with correct scaling.");

  await page.waitForTimeout(10000);

  await browser.close();

}

testBrowser().catch(console.error);