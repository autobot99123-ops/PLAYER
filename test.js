// Set PLAYWRIGHT_PATH to your playwright install, e.g.
//   set PLAYWRIGHT_PATH=C:\path\to\node_modules\playwright
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

// Set CHROME_PATH to a Chromium/Chrome binary; leave unset to use the one
// playwright downloaded itself.
const EXE = process.env.CHROME_PATH || undefined;
const URL = process.env.PLAYER_URL || 'http://127.0.0.1:4173/';

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => errors.push(`REQFAIL ${r.failure() && r.failure().errorText} ${r.url().split('/').pop()}`));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  await page.click('#libBtn');
  await page.waitForTimeout(300);
  await page.click('#list li');
  await page.waitForTimeout(2000);

  const out = {};

  // --- fullscreen via the transport button ---
  await page.click('#fullBtn');
  await page.waitForTimeout(900);
  out.entered = await page.evaluate(() => ({
    hasFsElement: !!document.fullscreenElement,
    fakeFs: document.body.classList.contains('fakefs'),
    bodyFs: document.body.classList.contains('fs'),
    stageHeight: Math.round(document.getElementById('stage').getBoundingClientRect().height),
    viewportHeight: window.innerHeight,
    videoHeight: Math.round(document.getElementById('video').getBoundingClientRect().height),
    exitVisible: !!document.querySelector('.fs-exit').offsetParent,
    transportVisible: !!document.querySelector('.transport').offsetParent,
  }));

  // --- leave via the new exit button ---
  await page.click('.fs-exit');
  await page.waitForTimeout(500);
  out.exitedViaButton = await page.evaluate(() => ({
    hasFsElement: !!document.fullscreenElement,
    fakeFs: document.body.classList.contains('fakefs'),
    bodyFs: document.body.classList.contains('fs'),
    transportBack: !!document.querySelector('.transport').offsetParent,
    fullBtnActive: document.getElementById('fullBtn').classList.contains('active'),
  }));

  // --- and via the F key ---
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(800);
  out.enteredByKey = await page.evaluate(() => ({
    fakeFs: document.body.classList.contains('fakefs'),
    bodyFs: document.body.classList.contains('fs'),
    hasFsElement: !!document.fullscreenElement,
  }));
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(400);
  out.exitedByKey = await page.evaluate(() => ({
    fakeFs: document.body.classList.contains('fakefs'),
    bodyFs: document.body.classList.contains('fs'),
  }));

  // --- audio graph reaches the destination? sample the meter over time ---
  out.audioOverTime = await page.evaluate(async () => {
    const v = document.getElementById('video');
    const badge = document.getElementById('audioState');
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 600));
      samples.push(badge.textContent);
    }
    return {
      samples,
      muted: v.muted,
      volume: v.volume,
      paused: v.paused,
      playing: !v.paused,
    };
  });

  // --- duplicate action check ---
  out.duplicateActions = await page.evaluate(() => {
    const seen = {};
    document.querySelectorAll('[data-act]').forEach((b) => {
      seen[b.dataset.act] = (seen[b.dataset.act] || 0) + 1;
    });
    return Object.entries(seen).filter(([, n]) => n > 1);
  });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error('RUNNER FAILED:', e.message); process.exit(1); });
