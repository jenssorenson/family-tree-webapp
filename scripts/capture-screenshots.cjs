#!/usr/bin/env node
/**
 * Visual QA screenshot capture for family-tree-webapp
 * Usage: node capture-screenshots.js [url] [outputDir]
 *
 * Captures the family tree app at multiple zoom levels to show
 * the full tree layout and node spacing.
 */

const puppeteer = require('puppeteer');

const APP_URL = process.argv[2] || 'http://localhost:5173';
const OUTPUT_DIR = process.argv[3] || './visual-qa';

const fs = require('fs');
const path = require('path');

async function capture() {
  // Ensure output dir
  const dir = path.resolve(OUTPUT_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = `qa-${timestamp}`;

  console.log(`[visual-qa] Launching browser for ${APP_URL}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  try {
    console.log(`[visual-qa] Navigating to ${APP_URL}`);
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for tree to render
    await page.waitForSelector('.d3-tree-viz', { timeout: 10000 });
    console.log('[visual-qa] Tree rendered, waiting for simulation to settle...');

    // Wait for simulation to settle (nodes stop moving)
    await new Promise(r => setTimeout(r, 4000));

    // Capture 1: Full tree overview (zoomed out to fit)
    const overviewPath = path.join(dir, `${prefix}-overview.png`);
    await page.screenshot({
      path: overviewPath,
      fullPage: false,
    });
    console.log(`[visual-qa] Saved overview: ${overviewPath}`);

    // Capture 2: Zoomed in on center
    await page.evaluate(() => {
      const svg = document.querySelector('.d3-tree-svg');
      if (svg) {
        // Trigger zoom to fit (dblclick or manual zoom out)
        const event = new WheelEvent('wheel', { deltaY: 500, bubbles: true });
        svg.dispatchEvent(event);
      }
    });
    await new Promise(r => setTimeout(r, 1000));

    const detailPath = path.join(dir, `${prefix}-detail.png`);
    await page.screenshot({
      path: detailPath,
      fullPage: false,
    });
    console.log(`[visual-qa] Saved detail: ${detailPath}`);

    // Capture 3: Capture with bounding box of the tree
    const treeBox = await page.evaluate(() => {
      const el = document.querySelector('.tree-viewport');
      if (!el) return null;
      const bbox = el.getBBox();
      const svgs = document.querySelector('.d3-tree-svg');
      const rect = svgs ? svgs.getBoundingClientRect() : { left: 0, top: 0 };
      return { bbox, rect };
    });

    // Metadata
    const meta = {
      url: APP_URL,
      timestamp: new Date().toISOString(),
      captures: [
        `${prefix}-overview.png`,
        `${prefix}-detail.png`,
      ],
      treeBounds: treeBox,
    };

    const metaPath = path.join(dir, `${prefix}-meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[visual-qa] Saved metadata: ${metaPath}`);
    console.log('[visual-qa] Done!');

  } finally {
    await browser.close();
  }
}

capture().catch(err => {
  console.error('[visual-qa] Error:', err.message);
  process.exit(1);
});
