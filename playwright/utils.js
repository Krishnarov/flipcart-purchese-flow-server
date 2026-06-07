export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const takeScreenshot = async (page, name) => {
  try {
    const fs = await import('fs');
    if (!fs.existsSync('screenshots')) {
      fs.mkdirSync('screenshots');
    }
    await page.screenshot({ path: `screenshots/${name}-${Date.now()}.png`, fullPage: true });
    console.log(`📸 Screenshot saved: screenshots/${name}.png`);
  } catch (error) {
    console.log("Could not take screenshot:", error.message);
  }
};
