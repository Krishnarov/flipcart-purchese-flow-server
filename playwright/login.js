import { delay, takeScreenshot } from './utils.js';

/**
 * Automates login on our local Vite React app.
 * @param {import('playwright').Page} page
 * @param {string} email
 * @param {string} password
 */
export const loginToApp = async (page, email, password) => {
  try {
    console.log('🌐 Navigating to app auth URL (http://localhost:5173/auth)...');
    await page.goto('http://localhost:5173/auth', { waitUntil: 'networkidle', timeout: 10000 });
    
    // Screenshot of initial loaded form
    await takeScreenshot(page, '1-login-loaded');

    console.log(`✍️ Filling email field with: ${email}`);
    await page.waitForSelector('#email', { timeout: 5000 });
    await page.fill('#email', email);
    await delay(500);

    console.log('✍️ Filling password field...');
    await page.waitForSelector('#current-password', { timeout: 5000 });
    await page.fill('#current-password', password);
    await delay(500);

    await takeScreenshot(page, '2-credentials-entered');

    console.log('🖱️ Clicking Submit button...');
    await page.click('button[type="submit"]');

    // Wait for the URL transition to the dashboard
    console.log('⏳ Waiting for /dashboard navigation...');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
    
    // Check main layout container exists
    await page.waitForSelector('.main-content', { timeout: 5000 });
    console.log('🎉 Successfully navigated to Dashboard! Login complete.');
    await takeScreenshot(page, '3-dashboard-overview');
    await delay(1000);

    // Click the Upload Excel sidebar tab to verify nested route navigation
    console.log('🌐 Testing navigation to Upload Excel tab (/uploads)...');
    await page.click('button:has-text("Upload Excel")');
    await page.waitForURL('**/uploads', { timeout: 5000 });
    await page.waitForSelector('.upload-card', { timeout: 5000 });
    console.log('✅ Excel upload view loaded successfully.');
    await takeScreenshot(page, '4-uploads-view-loaded');
    await delay(1000);

    // Logout
    console.log('🚪 Logging out from application...');
    await page.click('.logout-btn');
    await page.waitForURL('**/auth', { timeout: 5000 });
    console.log('✅ Successfully logged out.');
    await takeScreenshot(page, '5-logout-completed');

  } catch (error) {
    console.error('❌ Playwright automation session encountered an error:', error.message);
    await takeScreenshot(page, 'error-state');
    throw error;
  }
};
