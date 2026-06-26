const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  // Wait a second for animations
  await new Promise(r => setTimeout(r, 1000));
  
  // Click the 432237 project to show tasks
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.project-item'));
    const target = items.find(el => el.innerText.includes('432237 Read 6'));
    if (target) target.click();
  });
  
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: '/Users/jordan.jones/.gemini/antigravity/brain/fe3e79b5-a6de-4a89-8e1b-a2813d864e62/dashboard_names_fixed.png' });
  await browser.close();
})();
