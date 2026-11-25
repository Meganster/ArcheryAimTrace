// Render the editable SVG brand mark at each app-icon size. Requires Playwright.
import { readFile, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const svg = await readFile(new URL('icon.svg', root), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function render(size, maskable = false) {
    await page.setViewportSize({ width: size, height: size });
    const source = maskable ? svg.replace('rx="88"', 'rx="0"') : svg;
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${source}`);
    return page.screenshot({ omitBackground: true });
  }
  for (const [name, size, maskable] of [
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true],
  ]) await writeFile(new URL(name, root), await render(size, maskable));
  // ICO supports PNG entries; include crisp representations for browser tabs.
  const sizes = [16, 32, 48], entries = [];
  for (const size of sizes) entries.push(await render(size));
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((data, i) => {
    const pos = 6 + 16 * i;
    header[pos] = sizes[i]; header[pos + 1] = sizes[i];
    header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(data.length, pos + 8); header.writeUInt32LE(offset, pos + 12);
    offset += data.length;
  });
  await writeFile(new URL('favicon.ico', root), Buffer.concat([header, ...entries]));
  console.log('Rendered all five app icons from icon.svg.');
} finally { await browser.close(); }
