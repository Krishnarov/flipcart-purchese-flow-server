import { delay } from './utils.js';

/**
 * Checks kuku.lu temporary mail box and extracts the Flipkart OTP.
 * Uses smart polling instead of fixed delays for faster OTP retrieval.
 * @param {import('playwright').Page} page
 * @param {string} email
 * @returns {Promise<string>} The extracted OTP
 */
export const loginToEmail = async (page, email) => {
  try {
    console.log(`[Email] Navigating to kuku.lu mailbox for: ${email}`);
    await page.goto("https://m.kuku.lu/recv.php", {
      waitUntil: "domcontentloaded",
      timeout: 10000
    });

    console.log('[Email] Searching for mail address...');
    await page.waitForSelector('input[name="q"]', { timeout: 10000 });
    await page.locator('input[name="q"]').fill(email);
    await page.press('input[name="q"]', 'Enter');
    await delay(800);

    // Smart polling loop: reload up to 10 times, 2s apart (max 20s wait)
    console.log('[Email] Smart polling mailbox for OTP...');
    const MAX_RETRIES = 10;
    const POLL_INTERVAL = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Click the reload button
        const reloadBtn = page.locator('#image_reload');
        if (await reloadBtn.count() > 0) {
          await reloadBtn.click();
        }
        await delay(400);

        // Check if any mail title has appeared
        const subjectLocator = page.locator('[id^="area_mail_title_"] b span').first();
        const isVisible = await subjectLocator.isVisible().catch(() => false);

        if (isVisible) {
          const subjectText = (await subjectLocator.innerText()).trim();
          console.log(`[Email] Mail Subject Found (attempt ${attempt}): "${subjectText}"`);

          // Extract OTP (4 or 6 digits)
          const otpMatch = subjectText.match(/\b\d{4,6}\b/);
          if (otpMatch) {
            const otp = otpMatch[0];
            console.log(`[Email] Extracted OTP: ${otp}`);
            return otp;
          }
        }

        if (attempt < MAX_RETRIES) {
          console.log(`[Email] OTP not found yet (attempt ${attempt}/${MAX_RETRIES}). Waiting ${POLL_INTERVAL}ms...`);
          await delay(POLL_INTERVAL);
        }
      } catch (pollErr) {
        console.warn(`[Email] Poll attempt ${attempt} error: ${pollErr.message}`);
        await delay(POLL_INTERVAL);
      }
    }

    throw new Error(`OTP not received after ${MAX_RETRIES} polling attempts (${(MAX_RETRIES * POLL_INTERVAL) / 1000}s timeout)`);

  } catch (error) {
    console.error('[Email] Failed to retrieve OTP:', error.message);
    throw new Error(`Email OTP Fetch Failed: ${error.message}`);
  }
};
