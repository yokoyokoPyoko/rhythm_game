import { test, expect } from '@playwright/test'

test('debug wheel event on canvas', async ({ page }) => {
  await page.goto('/rhythm_game/#/editor')
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 10000 })
  await page.waitForTimeout(2000)
  
  // Add style to make page scrollable
  await page.addStyleTag({
    content: 'body { height: 4000px; } #root { min-height: 4000px; }',
  });
  await page.waitForTimeout(200);
  
  // Scroll down
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(100);
  const initialScrollY = await page.evaluate(() => window.scrollY);
  console.log('Initial scrollY:', initialScrollY);
  
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  const box = await canvas.boundingBox();
  console.log('Canvas box:', box);
  
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;  // Fixed: don't add scrollYOffset
  console.log('Click position:', cx, cy);
  
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(100);
  
  // Check what element is at mouse position
  const elementAtPoint = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className : '') : 'null';
  }, [cx, cy]);
  console.log('Element at point:', elementAtPoint);
  
  // Wheel up 5 times
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
  
  const midScrollY = await page.evaluate(() => window.scrollY);
  console.log('Mid scrollY (after wheel up):', midScrollY);
  
  // Wheel down 5 times
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(30);
  }
  
  const finalScrollY = await page.evaluate(() => window.scrollY);
  console.log('Final scrollY:', finalScrollY);
  
  // Also test dispatching wheel event directly on canvas
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(100);
  
  const result = await page.evaluate(async () => {
    const canvasEl = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement | null;
    if (!canvasEl) return { error: 'canvas not found' };
    return new Promise<{ defaultPrevented: boolean }>((resolve) => {
      const probe = (e: WheelEvent) => {
        const dp = e.defaultPrevented;
        canvasEl.removeEventListener('wheel', probe, false);
        resolve({ defaultPrevented: dp });
      };
      canvasEl.addEventListener('wheel', probe, false);
      const evt = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: canvasEl.getBoundingClientRect().left + canvasEl.width/2, clientY: canvasEl.getBoundingClientRect().top + canvasEl.height/2 });
      canvasEl.dispatchEvent(evt);
    });
  });
  console.log('Direct dispatch defaultPrevented:', result);
})