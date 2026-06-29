const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  try {
    const browser = await puppeteer.launch({ 
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
    
    // Wait for projects to load in sidebar
    await page.waitForSelector('.project-item');
    
    // Take a screenshot of the welcome state
    await page.screenshot({ path: '/Users/jordan.jones/.gemini/antigravity/brain/fe3e79b5-a6de-4a89-8e1b-a2813d864e62/dashboard_premium_welcome.png' });
    
    // Click the first project to load the dashboard state
    await page.click('.project-item');
    
    // Wait for the chart to render
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await page.screenshot({ path: '/Users/jordan.jones/.gemini/antigravity/brain/fe3e79b5-a6de-4a89-8e1b-a2813d864e62/dashboard_premium.png' });
    
    await browser.close();
    console.log("Screenshots saved.");
  } catch (err) {
    console.error("Puppeteer error:", err);
    process.exit(1);
  }
})();
