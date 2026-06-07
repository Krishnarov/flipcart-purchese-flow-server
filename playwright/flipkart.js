import { delay } from './utils.js';

/**
 * Initiates Flipkart login by filling username and clicking Request OTP.
 * Uses domcontentloaded instead of networkidle for faster page ready detection.
 * @param {import('playwright').Page} page
 * @param {string} username
 */
export const loginToFlipkart = async (page, username) => {
  try {
    console.log(`[Flipkart] Navigating to login page for: ${username}`);
    await page.goto('https://www.flipkart.com/account/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for the email input to appear (faster than waiting for network)
    console.log('[Flipkart] Waiting for login input...');
    await page.waitForSelector('input.c3Bd2c.yXUQVt', { timeout: 15000 });

    console.log('[Flipkart] Filling email/username...');
    await page.fill('input.c3Bd2c.yXUQVt', username);

    // Short delay to let the button become interactive
    await delay(500);

    console.log('[Flipkart] Clicking Request OTP...');
    await page.getByRole('button', { name: /Request OTP/i }).click();
    console.log('[Flipkart] Request OTP clicked.');

    // Wait for OTP input fields to appear (confirm OTP page loaded)
    await page.waitForSelector('input[maxlength="1"]', { timeout: 15000 });
    console.log('[Flipkart] OTP input page detected.');

  } catch (error) {
    console.error('[Flipkart] Login initiation failed:', error.message);
    throw new Error(`Flipkart Login Init Failed: ${error.message}`);
  }
};

/**
 * Submits the OTP to complete the Flipkart login.
 * @param {import('playwright').Page} page
 * @param {string} otp
 */
export const loginToFlipkartWithOTP = async (page, otp) => {
  try {
    console.log(`[Flipkart] Entering OTP digits: ${otp}`);
    // OTP inputs should already be visible (verified in loginToFlipkart)
    const inputs = page.locator('input[maxlength="1"]');
    const count = await inputs.count();

    if (count < otp.length) {
      throw new Error(`OTP inputs found (${count}) is less than OTP length (${otp.length})`);
    }

    const digits = otp.split('');
    for (let i = 0; i < digits.length; i++) {
      await inputs.nth(i).fill(digits[i]);
    }
    console.log('[Flipkart] OTP fields filled.');

    // Wait briefly for form auto-submit or click verify if needed
    await delay(300);

    // Some Flipkart versions auto-submit, others need a button click
    const verifyBtn = page.getByRole('button', { name: /verify/i });
    if (await verifyBtn.count() > 0) {
      await verifyBtn.click().catch(() => {});
    }

  } catch (error) {
    console.error('[Flipkart] OTP entry failed:', error.message);
    throw new Error(`Flipkart OTP Submission Failed: ${error.message}`);
  }
};
