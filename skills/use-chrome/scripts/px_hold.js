async (page) => {
  const sleep = ms => page.waitForTimeout(ms);
  const boxes = [];
  for (const f of await page.locator('iframe').all()) {
    const b = await f.boundingBox().catch(() => null);
    if (b && b.width > 100 && b.height > 20) boxes.push(b);
  }
  let box = boxes[0];
  if (!box) box = await page.locator('#px-captcha').boundingBox().catch(() => null);
  if (!box) return JSON.stringify({ err: 'nobox', boxes });
  const x = box.x + box.width / 2 + (Math.random() - .5) * 20, y = box.y + 27 + (Math.random() - .5) * 6;
  const s = { x: x + 260 + Math.random() * 150, y: y + 160 + Math.random() * 100 };
  const c = { x: (s.x + x) / 2 + (Math.random() - .5) * 140, y: (s.y + y) / 2 + (Math.random() - .5) * 140 };
  const steps = 30 + Math.floor(Math.random() * 12);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move((1 - e) ** 2 * s.x + 2 * (1 - e) * e * c.x + e * e * x + (Math.random() - .5) * 1.5,
      (1 - e) ** 2 * s.y + 2 * (1 - e) * e * c.y + e * e * y + (Math.random() - .5) * 1.5);
    await sleep(10 + Math.random() * 18);
  }
  await sleep(250 + Math.random() * 200);
  await page.mouse.down();
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 15000) {
    await sleep(300 + Math.random() * 200);
    if (Math.random() < .5) await page.mouse.move(x + (Math.random() - .5) * 2, y + (Math.random() - .5) * 2);
    const title = await page.title().catch(() => 'nav');
    if (!/denied/i.test(title)) { ok = true; break; }
  }
  const held = Date.now() - t0;
  await page.mouse.up();
  await sleep(5000);
  return JSON.stringify({ box, held, ok, title: await page.title().catch(() => '?') });
}
