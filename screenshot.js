const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.project-item');
  // Click God's Gift
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.project-item')];
    const target = items.find(i => i.textContent.includes("God's Gift"));
    if (target) target.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  // Expand first section and tasks
  await page.evaluate(() => {
    const sectionHeaders = document.querySelectorAll('.section-header');
    if (sectionHeaders.length > 0) sectionHeaders[0].click();
  });
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => {
    const tasks = document.querySelectorAll('.task-item');
    tasks.forEach(t => {
      const exp = t.querySelector('.task-expand-icon');
      if (exp) exp.click();
    });
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'verify.png', fullPage: true });
  await browser.close();
})();
