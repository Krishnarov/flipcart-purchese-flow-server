import { chromium } from 'playwright';
import { loginToApp } from '../playwright/login.js';
import readline from 'readline';

const askQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
};

const run = async () => {
  let email = process.argv[2];
  let password = process.argv[3];

  // If credentials are not passed, prompt interactively
  if (!email || !password) {
    console.log('\n🎭 Playwright E2E Login Automation');
    console.log('---------------------------------');
    if (!email) {
      email = await askQuestion('📧 Enter Account Email: ');
    }
    if (!password) {
      password = await askQuestion('🔑 Enter Account Password: ');
    }
    console.log('---------------------------------\n');
  }

  if (!email || !password) {
    console.error('❌ Error: Both Email and Password are required.');
    process.exit(1);
  }

  console.log('🚀 Launching Chromium instance...');
  
  // Launch in headless mode so it runs silently in the background
  const browser = await chromium.launch({
    headless: true
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    
    await loginToApp(page, email, password);
    
    console.log('\n🎉 Automation Flow Finished: All phases passed!');
    console.log('Check the "server/screenshots" directory to view progress captures.\n');

  } catch (error) {
    console.error('\n❌ Automation Session Failed:', error.message);
  } finally {
    await browser.close();
    console.log('Browser instance closed.');
  }
};

run();
