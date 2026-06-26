const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  
  await page.goto('http://localhost:3000');
  
  // Wait for data to load and sidebar to populate
  await page.waitForSelector('.project-item');
  
  // Click the first project
  await page.click('.project-item');
  
  // Wait for animation to finish
  await new Promise(r => setTimeout(r, 1000));
  
  await page.screenshot({ path: '/Users/jordan.jones/.gemini/antigravity/brain/fe3e79b5-a6de-4a89-8e1b-a2813d864e62/dashboard_preview.png' });
  await browser.close();
  console.log("Screenshot saved.");
})();
