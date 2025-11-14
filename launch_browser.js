import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CDP_PORT = process.env.CDP_PORT || "9222";
const HEADLESS = process.env.HEADLESS === "false" ? false : true;
const WINDOW_SIZE = process.env.WINDOW_SIZE || "1920,1080";

try {
  console.log(
    `[BROWSER] Launching Chromium (headless: ${HEADLESS}) on CDP port ${CDP_PORT}...`
  );

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${WINDOW_SIZE}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--ignore-certificate-errors",
      "--enable-automation",
    ],
  });

  console.log("[BROWSER] Browser launched. Waiting for disconnection...");

  await new Promise((resolve) => {
    browser.on("disconnected", resolve);
  });

  console.log("[BROWSER] Chromium has been disconnected. Exiting.");
} catch (error) {
  console.error("[BROWSER] Critical error:", error.message);
  process.exit(1);
}
