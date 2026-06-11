import { chromium } from "playwright";
import fs from "fs";
import AutomationJob from "../models/AutomationJob.js";
import Purchase from "../models/Purchase.js";
import LoginEmail from "../models/LoginEmail.js";
import { loginToFlipkart, loginToFlipkartWithOTP } from "./flipkart.js";
import { loginToEmail } from "./kukuEmail.js";
import { delay } from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const CONCURRENCY = 1; // How many emails to process in parallel

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-blink-features=AutomationControlled",
  "--disable-geolocation",
  "--disable-notifications",
  "--disable-dev-shm-usage", // Prevents crashes in low-memory environments
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Safely saves a Mongoose document — retries with a fresh document on VersionError */
const safeSaveRecord = async (record) => {
  try {
    await record.save();
  } catch (err) {
    if (err.name === "VersionError") {
      console.warn(
        `⚠️ [Automation] VersionError for ${record.email || record._id}. Retrying with fresh document...`,
      );
      const freshRecord = await record.constructor.findById(record._id);
      if (freshRecord) {
        const modifiedPaths = record.modifiedPaths();
        for (const path of modifiedPaths) {
          freshRecord[path] = record[path];
        }
        await freshRecord.save();
      }
    } else {
      throw err;
    }
  }
};

/** Helper to emit live log updates to UI */
const emitLiveLog = async (record, message, status, io) => {
  if (message) record.reason = message;
  if (status) record.status = status;
  await safeSaveRecord(record);
  if (io) {
    io.emit("live-log", {
      jobId: record.jobId,
      email: record.email,
      name: record.name,
      message: record.reason,
      status: record.status,
    });
    io.emit("job-update", { type: "email-update", jobId: record.jobId });
  }
};

/** Ensures screenshots directory exists */
const ensureScreenshotsDir = () => {
  if (!fs.existsSync("screenshots")) {
    fs.mkdirSync("screenshots", { recursive: true });
  }
};

/** Helper to mark a record as failed, take a screenshot, and emit updates */
const failRecord = async (record, page, prefix, reason, io) => {
  let screenshotPath = "";
  try {
    if (page) {
      ensureScreenshotsDir();
      screenshotPath = `screenshots/${prefix}-${record.email}-${Date.now()}.png`;
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch(() => { });
    }
  } catch (err) {
    console.error(
      `⚠️ [Automation] Error taking screenshot for ${record.email}: ${err.message}`,
    );
  }

  record.completedAt = new Date();
  if (screenshotPath) record.screenshot = screenshotPath;
  record.status = "failed";
  await emitLiveLog(record, reason, "failed", io);
  console.log(
    `❌ [Automation] DB saved — ${record.email} - ${record.name} (Failed: ${reason})`,
  );
};

/**
 * Login flow processing.
 */
const processLogin = async (records, emailContext, jobId, runHeadless, io) => {
  let flipkartBrowser = null;
  let flipkartContext = null;
  let emailPage = null;
  const primaryRecord = records[0];

  try {
    for (const r of records) {
      r.reason = "Automation is running...";
      await safeSaveRecord(r);
    }

    flipkartBrowser = await chromium.launch({
      headless: runHeadless,
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    flipkartContext = await flipkartBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
    });
    const flipkartPage = await flipkartContext.newPage();
    emailPage = await emailContext.newPage();

    await loginToFlipkart(flipkartPage, primaryRecord.email);
    const otp = await loginToEmail(emailPage, primaryRecord.email);
    await loginToFlipkartWithOTP(flipkartPage, otp);

    console.log(
      `[Automation] Waiting for post-login redirect: ${primaryRecord.email}`,
    );
    try {
      await flipkartPage.waitForURL((url) => !url.includes("/account/login"), {
        timeout: 20000,
      });
    } catch (_) { }

    await flipkartPage.waitForLoadState("load").catch(() => { });
    await flipkartPage
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => { });

    const verificationFailed = flipkartPage.getByText(
      /Verification unsuccessful/i,
    );
    if ((await verificationFailed.count()) > 0) {
      throw new Error(
        "Flipkart flagged the attempt as verification unsuccessful.",
      );
    }

    let cookies = [];
    try {
      cookies = await flipkartContext.cookies();
    } catch (cookieErr) { }

    let localStorageData = {};
    try {
      localStorageData = await flipkartPage.evaluate(() => {
        const d = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          d[k] = localStorage.getItem(k);
        }
        return d;
      });
    } catch (lsErr) { }

    let sessionStorageData = {};
    try {
      sessionStorageData = await flipkartPage.evaluate(() => {
        const d = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          d[k] = sessionStorage.getItem(k);
        }
        return d;
      });
    } catch (ssErr) { }

    ensureScreenshotsDir();
    const screenshotPath = `screenshots/success-${primaryRecord.email}-${Date.now()}.png`;
    await flipkartPage.screenshot({ path: screenshotPath, fullPage: false });

    for (const r of records) {
      r.status = "success";
      r.completedAt = new Date();
      r.reason = `Login successful. Cookies: ${cookies.length} | LS keys: ${Object.keys(localStorageData).length}`;
      r.screenshot = screenshotPath;
      r.cookies = cookies;
      r.localStorage = localStorageData;
      r.sessionStorage = sessionStorageData;
      r.markModified("cookies");
      r.markModified("localStorage");
      r.markModified("sessionStorage");
      await safeSaveRecord(r);
    }
    if (io) io.emit("job-update", { type: "email-update", jobId });
    console.log(
      `✅ [Automation] DB saved — ${primaryRecord.email} | Cookies: ${cookies.length} (applied to ${records.length} records)`,
    );
  } catch (error) {
    console.error(
      `❌ [Automation] Error: ${primaryRecord.email} — ${error.message}`,
    );

    let screenshotPath = "";
    try {
      if (flipkartContext) {
        const pages = flipkartContext.pages();
        if (pages.length > 0) {
          ensureScreenshotsDir();
          screenshotPath = `screenshots/failed-${primaryRecord.email}-${Date.now()}.png`;
          await pages[0].screenshot({ path: screenshotPath, fullPage: false });
        }
      }
    } catch (_) { }

    for (const r of records) {
      r.status = "failed";
      r.completedAt = new Date();
      r.reason = error.message;
      if (screenshotPath) r.screenshot = screenshotPath;
      r.markModified("cookies");
      r.markModified("localStorage");
      r.markModified("sessionStorage");
      await safeSaveRecord(r);
    }
    if (io) io.emit("job-update", { type: "email-update", jobId });
  } finally {
    try {
      if (emailPage) await emailPage.close();
    } catch (_) { }
    try {
      if (flipkartBrowser) await flipkartBrowser.close();
    } catch (_) { }
  }
};

/**
 * Purchase flow processing.
 */
const processPurchase = async (records, jobId, runHeadless, io) => {
  let flipkartBrowser = null;
  let flipkartContext = null;
  let flipkartPage = null;
  const primaryRecord = records[0];

  try {
    // We only set the first record to inprogress initially to show address processing activity
    await emitLiveLog(primaryRecord, "Starting process...", "inprogress", io);

    const loginSession = await LoginEmail.findOne({
      email: primaryRecord.email,
      status: "success",
    });
    if (!loginSession) {
      throw new Error(
        `No saved login session found for ${primaryRecord.email}.`,
      );
    }

    flipkartBrowser = await chromium.launch({
      headless: runHeadless,
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    });

    flipkartContext = await flipkartBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
    });

    // BLOCK ALL POPUPS & GEOLOCATION
    await flipkartContext.addInitScript(() => {
      // 1. Disable Geolocation API
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (s, e) => {
            if (e) e({ code: 1, message: "Geolocation is disabled." });
          },
          watchPosition: (s, e) => {
            if (e) e({ code: 1, message: "Geolocation is disabled." });
          },
        },
      });
      // 2. Mock Permissions API
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = (parameters) => {
        if (
          parameters.name === "geolocation" ||
          parameters.name === "notifications"
        ) {
          return Promise.resolve({ state: "denied" });
        }
        return originalQuery(parameters);
      };
    });

    if (loginSession.cookies && loginSession.cookies.length > 0) {
      await flipkartContext.addCookies(loginSession.cookies);
    }

    flipkartPage = await flipkartContext.newPage();

    // Must visit origin first to set localStorage
    await flipkartPage.goto("https://www.flipkart.com", {
      waitUntil: "domcontentloaded",
    });

    if (
      loginSession.localStorage &&
      Object.keys(loginSession.localStorage).length > 0
    ) {
      await flipkartPage.evaluate((ls) => {
        for (const [k, v] of Object.entries(ls)) {
          localStorage.setItem(k, v);
        }
      }, loginSession.localStorage);
    }

    if (
      loginSession.sessionStorage &&
      Object.keys(loginSession.sessionStorage).length > 0
    ) {
      await flipkartPage.evaluate((ss) => {
        for (const [k, v] of Object.entries(ss)) {
          sessionStorage.setItem(k, v);
        }
      }, loginSession.sessionStorage);
    }

    // Check if all current records already have their address saved
    const isAddressSaved = records.every((r) => r.addressSaved === true);
    // Check if stop requested before address processing
    const currentJobStatusBeforeAddress = (await AutomationJob.findById(jobId))
      .status;
    if (currentJobStatusBeforeAddress === "stopped") {
      console.log(
        `🛑 [Automation] Job stopped before address processing for ${primaryRecord.email}.`,
      );
      return;
    }

    if (isAddressSaved) {
      console.log(
        `[Automation] Addresses already saved for all tasks of ${primaryRecord.email}. Skipping address creation.`,
      );
    } else {
      const targetUrl = "https://www.flipkart.com/account/addresses";
      console.log(
        `[Automation] Navigating to target: ${targetUrl} for ${primaryRecord.email}`,
      );
      await flipkartPage.goto(targetUrl, { waitUntil: "domcontentloaded" });

      // Wait for address page layout to render dynamically
      const addressHeader = flipkartPage
        .locator("text=/Manage Addresses/i")
        .first();
      const anyAddressDot = flipkartPage.locator(".IVvp_M").first();
      const addAddrBtn = flipkartPage
        .locator("text=/ADD A NEW ADDRESS|ADD ADDRESSES/i")
        .first();
      const loginForm = flipkartPage.locator("text=/Login/i").first();

      const loadedElem = addressHeader
        .or(anyAddressDot)
        .or(addAddrBtn)
        .or(loginForm);
      await loadedElem
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => { });

      // Fetch all pending records for this email to add all addresses at once
      const emailRecordsToProcess = await Purchase.find({
        jobId,
        email: primaryRecord.email,
        status: { $in: ["pending", "inprogress"] },
      }).sort({ _id: 1 });

      // Delete all addresses logic
      let deletedCount = 0;
      let maxRetries = 30; // safety limit to prevent infinite loops

      await emitLiveLog(
        primaryRecord,
        "Removing existing addresses...",
        null,
        io,
      );

      // Wait 2s for dots to be properly loaded and interactive
      await delay(2000);

      while (maxRetries > 0) {
        // Check for stop after each deletion iteration
        const jobStatusDuringDeletion = (await AutomationJob.findById(jobId))
          .status;
        if (jobStatusDuringDeletion === "stopped") {
          console.log(
            `🛑 [Automation] Job stopped during address deletion for ${primaryRecord.email}.`,
          );
          return;
        }
        maxRetries--;

        const dotsCount = await flipkartPage.locator(".IVvp_M").count();
        if (dotsCount === 0) {
          break; // No more addresses found
        }

        try {
          // Just hover the first dot
          const firstDot = flipkartPage.locator(".IVvp_M").first();
          await firstDot.hover({ timeout: 1500 });

          // More specific locator for Delete option and wait for it
          const deleteBtn = flipkartPage.locator('.uAwQ3C:has-text("Delete")').first();
          await deleteBtn.waitFor({ state: "visible", timeout: 2000 });
          await deleteBtn.click({ timeout: 1000 });

          // More specific locator for YES, DELETE confirmation and wait for it
          const confirmBtn = flipkartPage.locator('button:has-text("YES, DELETE")').first();
          await confirmBtn.waitFor({ state: "visible", timeout: 2000 });
          await confirmBtn.click({ timeout: 1000 });

          deletedCount++;
          console.log(
            `[Automation] Deleted address ${deletedCount} for ${primaryRecord.email}`,
          );

          // Wait until the number of dots decreases in the DOM
          await Promise.all([
            flipkartPage
              .waitForFunction(
                (expectedCount) => {
                  return (
                    document.querySelectorAll(".IVvp_M").length < expectedCount
                  );
                },
                dotsCount,
                { timeout: 3000 },
              )
              .catch(() => { }),
            delay(300), // Small stability delay
          ]);
        } catch (err) {
          console.log(
            `[Automation] Minor error during deletion (retrying): ${err.message}`,
          );
          await delay(500); // short delay before retry
        }
      }

      // Now add new addresses
      // Check if stop requested before adding new addresses
      const jobStatusBeforeAdd = (await AutomationJob.findById(jobId)).status;
      if (jobStatusBeforeAdd === "stopped") {
        console.log(
          `🛑 [Automation] Job stopped before adding new addresses for ${primaryRecord.email}.`,
        );
        return;
      }
      for (const r of emailRecordsToProcess) {
        try {
          await emitLiveLog(
            primaryRecord,
            `Adding address for ${r.name || r.email}...`,
            null,
            io,
          );

          const addAddressesEmptyBtn = flipkartPage
            .locator('button:has-text("ADD ADDRESSES")')
            .first();
          const addNewAddressBtn = flipkartPage
            .locator('div.cv8zZS:has-text("ADD A NEW ADDRESS")')
            .first();
          const fallbackBtn = flipkartPage
            .locator("text=/ADD A NEW ADDRESS|ADD ADDRESSES/i")
            .first();
          const addBtn = addAddressesEmptyBtn
            .or(addNewAddressBtn)
            .or(fallbackBtn);

          await addBtn.waitFor({ state: "visible", timeout: 3000 });
          await addBtn.click();

          // Wait for form inputs to load
          const nameInput = flipkartPage.locator('input[name="name"]').first();
          await nameInput.waitFor({ state: "visible", timeout: 2000 });

          // Fill form fields
          if (r.name) await nameInput.fill(r.name);
          if (r.phone)
            await flipkartPage.locator('input[name="phone"]').fill(r.phone);
          if (r.pincode) {
            await flipkartPage.locator('input[name="pincode"]').fill(r.pincode);
            // No static delay needed; City/State autofills while filling other fields
          }

          // Flipkart Locality is often name="addressLine2" and Address Area is "addressLine1" (textarea)
          if (r.addressline2)
            await flipkartPage
              .locator('input[name="addressLine2"]')
              .fill(r.addressline2);
          if (r.addressline1) {
            const textarea = flipkartPage.locator(
              'textarea[name="addressLine1"]',
            );
            if ((await textarea.count()) > 0) {
              await textarea.fill(r.addressline1);
            } else {
              await flipkartPage
                .locator('input[name="addressLine1"]')
                .fill(r.addressline1);
            }
          }

          if (r.landmark)
            await flipkartPage
              .locator('input[name="landmark"]')
              .fill(r.landmark);
          if (r.alternatephone)
            await flipkartPage
              .locator('input[name="alternatePhone"]')
              .fill(r.alternatephone);
          await delay(500)
          // Save address
          const saveBtn = flipkartPage
            .locator('button:has-text("Save")')
            .first();
          await saveBtn.click();

          // Wait for save form to submit/close
          await saveBtn.waitFor({ state: "hidden", timeout: 5000 });

          r.addressSaved = true;
          // After saving address, check if stop was requested
          const jobStatusAfterAddress = (await AutomationJob.findById(jobId))
            .status;
          if (jobStatusAfterAddress === "stopped") {
            console.log(
              `🛑 [Automation] Job stopped after adding address for ${r.email}.`,
            );
            return;
          }
          await safeSaveRecord(r);
          await emitLiveLog(
            primaryRecord,
            `Address saved for ${r.email} - ${r.name}`,
            null,
            io,
          );

          console.log(
            `✅ [Automation] Address saved for ${r.email} - ${r.name}`,
          );
        } catch (err) {
          console.error(
            `❌ [Automation] Error adding address for ${r.email}: ${err.message}`,
          );
          r.status = "failed";
          r.completedAt = new Date();
          r.reason = `Failed to add address: ${err.message}`;
          await safeSaveRecord(r);

          await emitLiveLog(
            primaryRecord,
            `Failed to add address for ${r.name}: ${err.message}`,
            null,
            io,
          );

          // Recover state by reloading the page to clear the modal
          await flipkartPage.reload({ waitUntil: "domcontentloaded" });
          await flipkartPage.waitForTimeout(2000);
        }
      }
    }

    // Sequentially process cart for each record in the group
    for (const currentRecord of records) {
      if (currentRecord.status === "failed") continue;

      const currentJob = await AutomationJob.findById(jobId);
      if (!currentJob || currentJob.status === "stopped") {
        if (currentRecord.status !== "inprogress") {
          console.log(
            `🛑 [Automation] Job stopped by user. Halting remaining records for ${currentRecord.email}.`,
          );
          break;
        }
      }

      await emitLiveLog(currentRecord, "Clearing cart...", "inprogress", io);

      const cartUrl = "https://www.flipkart.com/viewcart";
      await flipkartPage.goto(cartUrl, { waitUntil: "domcontentloaded" });

      const firstPlaceOrderBtn = flipkartPage
        .locator("text=/Place Order/i")
        .first();
      const firstEmptyCartText = flipkartPage
        .locator('text="Your cart is empty!"')
        .first();
      await firstPlaceOrderBtn
        .or(firstEmptyCartText)
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => { });

      // Keep removing items until cart is empty
      let cartMaxRetries = 20;
      while (cartMaxRetries > 0) {
        cartMaxRetries--;
        const emptyText = flipkartPage
          .locator('text="Your cart is empty!"')
          .first();
        if (await emptyText.isVisible().catch(() => false)) {
          break; // Cart is empty
        }

        const removeBtn = flipkartPage.locator('text="Remove"').first();
        if (await removeBtn.isVisible().catch(() => false)) {
          await removeBtn.click();

          // Wait for confirmation button in the modal
          const confirmRemoveBtn = flipkartPage.locator('text="Remove"').last();
          await confirmRemoveBtn
            .waitFor({ state: "visible", timeout: 2000 })
            .catch(() => { });
          await confirmRemoveBtn.click({ timeout: 1500 }).catch(() => { });

          // Wait for the remove button to be detached
          await removeBtn
            .waitFor({ state: "detached", timeout: 3500 })
            .catch(() => { });
          await delay(300); // Small stability delay
        } else {
          break; // No more remove buttons found
        }
      }

      await emitLiveLog(
        currentRecord,
        "Navigating to product page...",
        "inprogress",
        io,
      );

      let prodUrl = currentRecord.productlink || "";
      if (prodUrl && !prodUrl.startsWith("http")) {
        prodUrl = `https://www.flipkart.com/product/p/itme?pid=${currentRecord.productlink}`;
      } else if (!prodUrl) {
        prodUrl = "https://www.flipkart.com"; // fallback if no product link provided
      }

      await flipkartPage.goto(prodUrl, { waitUntil: "domcontentloaded" });
      // await delay(4000); // Give time for product page to load

      // Check for Notify Me or Out of Stock first
      const notifyMeBtn = flipkartPage.locator("text=/Notify Me/i").first();
      const outOfStockText = flipkartPage
        .locator("text=/Out of stock|Sold Out|Currently unavailable/i")
        .first();
      const unavailableLocator = notifyMeBtn.or(outOfStockText);

      // Perform a highly optimized wait for EITHER Notify Me or Out of Stock to show
      const isUnavailable = await unavailableLocator
        .waitFor({ state: "visible", timeout: 1000 })
        .then(() => true)
        .catch(() => false);

      if (isUnavailable) {
        const isNotifyMe = await notifyMeBtn.isVisible().catch(() => false);
        const failureReason = isNotifyMe ? "Notify Me" : "Out of Stock";
        await failRecord(
          currentRecord,
          flipkartPage,
          "product-failed",
          failureReason,
          io,
        );
        continue;
      }

      // Check for Add to cart
      const addToCartTextBtn = flipkartPage
        .locator("text=/Add to cart/i")
        .first();
      const addToCartIconBtn = flipkartPage
        .locator('svg:has(clipPath[id^="AddToCart"])')
        .first();

      let clickedAddToCart = false;

      const isAddToCartText = await addToCartTextBtn
        .waitFor({ state: "visible", timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      const isAddToCartIcon = await addToCartIconBtn
        .waitFor({ state: "visible", timeout: 2000 })
        .then(() => true)
        .catch(() => false);

      if (isAddToCartText) {
        await addToCartTextBtn.click({ force: true });
        clickedAddToCart = true;
      } else if (isAddToCartIcon) {
        await addToCartIconBtn.click({ force: true });
        clickedAddToCart = true;
      }

      if (clickedAddToCart) {
        await emitLiveLog(
          currentRecord,
          "Added to cart. Navigating to cart...",
          "inprogress",
          io,
        );

        // Wait dynamically for URL update or Go to Cart button visibility
        const goToCartBtn = flipkartPage.locator("text=/Go to cart/i").first();
        await Promise.race([
          flipkartPage
            .waitForURL((url) => url.includes("/viewcart"), { timeout: 3500 })
            .catch(() => { }),
          goToCartBtn
            .waitFor({ state: "visible", timeout: 3500 })
            .catch(() => { }),
        ]);

        await flipkartPage.goto("https://www.flipkart.com/viewcart", {
          waitUntil: "domcontentloaded",
        });

        const placeOrderBtn = flipkartPage
          .locator("text=/Place Order/i")
          .first();
        const emptyCartText = flipkartPage
          .locator('text="Your cart is empty!"')
          .first();
        await placeOrderBtn
          .or(emptyCartText)
          .waitFor({ state: "visible", timeout: 6000 })
          .catch(() => { });

        await emitLiveLog(
          currentRecord,
          "Selecting address and placing order...",
          "inprogress",
          io,
        );

        console.log(
          `[Automation Tracking] Searching for Change or Pincode button...`,
        );
        const changeOrPincodeBtn = flipkartPage
          .locator("text=/Change|Enter Delivery Pincode/i")
          .first();
        const isBtnVisible = await changeOrPincodeBtn
          .waitFor({ state: "visible", timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        console.log(
          `[Automation Tracking] Change or Pincode button visible: ${isBtnVisible}`,
        );
        if (isBtnVisible) {
          console.log(
            `[Automation Tracking] Clicking Change or Pincode button...`,
          );
          await changeOrPincodeBtn.click({ force: true });

          // Wait for address container or address name element to load dynamically
          const nameSelector = flipkartPage
            .locator("div")
            .filter({ hasText: new RegExp(currentRecord.name, "i") })
            .first();
          await nameSelector
            .waitFor({ state: "visible", timeout: 3500 })
            .catch(() => { });
        } else {
          console.log(
            `[Automation Tracking] Change or Pincode button NOT found within 4s.`,
          );
        }

        if (currentRecord.name) {
          console.log(
            `[Automation Tracking] Searching for address name: ${currentRecord.name}...`,
          );

          // Locate the specific address container/sidebar/modal on the page to prevent clicking main cart product links
          const addressContainer = flipkartPage
            .locator('div[tabindex="0"]')
            .filter({
              hasText: new RegExp(currentRecord.name, "i"),
            })
            .first();

          const containerVisible = await addressContainer
            .isVisible({ timeout: 2000 })
            .catch(() => false);
          const rootLocator = containerVisible
            ? addressContainer
            : flipkartPage;
          console.log(
            `[Automation Tracking] Scoping search to address container: ${containerVisible}`,
          );

          let clickedAddress = false;

          // Try multiple robust locators inside the rootLocator
          const locators = [
            // Option 1: Card with z-index: 0 containing the name, clicking its cursor: pointer child
            async () => {
              const card = rootLocator
                .locator('div[style*="z-index: 0"]')
                .filter({ hasText: new RegExp(currentRecord.name, "i") })
                .first();
              if (await card.isVisible({ timeout: 1500 })) {
                const clickable = card
                  .locator('div[style*="cursor: pointer"]')
                  .first();
                await clickable.click({ force: true });
                return true;
              }
              return false;
            },
            // Option 2: Card with z-index:0 (no space) containing the name
            async () => {
              const card = rootLocator
                .locator('div[style*="z-index:0"]')
                .filter({ hasText: new RegExp(currentRecord.name, "i") })
                .first();
              if (await card.isVisible({ timeout: 1000 })) {
                const clickable = card
                  .locator('div[style*="cursor: pointer"]')
                  .first();
                await clickable.click({ force: true });
                return true;
              }
              return false;
            },
            // Option 3: Locate any div style="cursor: pointer" containing the name directly
            async () => {
              const item = rootLocator
                .locator('div[style*="cursor: pointer"]')
                .filter({ hasText: new RegExp(currentRecord.name, "i") })
                .first();
              if (await item.isVisible({ timeout: 1000 })) {
                await item.click({ force: true });
                return true;
              }
              return false;
            },
            // Option 4: Look for the text element directly and click it
            async () => {
              const nameElement = rootLocator
                .locator("div")
                .filter({ hasText: new RegExp(`^${currentRecord.name}$`, "i") })
                .first();
              if (await nameElement.isVisible({ timeout: 1000 })) {
                await nameElement.click({ force: true });
                return true;
              }
              return false;
            },
          ];

          for (let idx = 0; idx < locators.length; idx++) {
            try {
              console.log(
                `[Automation Tracking] Trying address locator option ${idx + 1}...`,
              );
              const success = await locators[idx]();
              if (success) {
                console.log(
                  `[Automation Tracking] Option ${idx + 1} succeeded in clicking the address.`,
                );
                clickedAddress = true;
                break;
              }
            } catch (err) {
              console.log(
                `[Automation Tracking] Option ${idx + 1} failed: ${err.message}`,
              );
            }
          }

          if (clickedAddress) {
            console.log(
              `[Automation Tracking] Clicked address. Checking for 'Deliver Here' button...`,
            );
            const deliverHereBtn = flipkartPage
              .locator("text=/Deliver Here/i")
              .first();
            try {
              await deliverHereBtn.waitFor({ state: "visible", timeout: 3000 });
              console.log(
                `[Automation Tracking] 'Deliver Here' button found. Clicking it...`,
              );
              await deliverHereBtn.click();
            } catch (e) {
              console.log(
                `[Automation Tracking] 'Deliver Here' button not found or not needed.`,
              );
            }

            console.log(
              `[Automation Tracking] Waiting for 'Deliver Here' to disappear and cart to update...`,
            );
            await deliverHereBtn
              .waitFor({ state: "hidden", timeout: 5000 })
              .catch(() => { });

            // Give any automatic redirect a brief moment to stabilize
            await flipkartPage
              .waitForLoadState("domcontentloaded")
              .catch(() => { });

            // Check if page redirected away from viewcart (e.g. back to product page)
            let currentUrl = flipkartPage.url();
            console.log(
              `[Automation Tracking] Current URL after address selection: ${currentUrl}`,
            );
            if (!currentUrl.includes("/viewcart")) {
              console.log(
                `[Automation Tracking] ⚠️ Redirected away from cart page. Navigating back to cart page...`,
              );
              await flipkartPage.goto("https://www.flipkart.com/viewcart", {
                waitUntil: "domcontentloaded",
              });
              const placeOrderBtn = flipkartPage
                .locator("text=/Place Order/i")
                .first();
              const emptyCartText = flipkartPage
                .locator('text="Your cart is empty!"')
                .first();
              await placeOrderBtn
                .or(emptyCartText)
                .waitFor({ state: "visible", timeout: 6000 })
                .catch(() => { });
              currentUrl = flipkartPage.url();
            } else {
              console.log(
                `[Automation Tracking] Refreshing cart page once to ensure state stability...`,
              );
              await flipkartPage.reload({ waitUntil: "domcontentloaded" });
              const placeOrderBtn = flipkartPage
                .locator("text=/Place Order/i")
                .first();
              const emptyCartText = flipkartPage
                .locator('text="Your cart is empty!"')
                .first();
              await placeOrderBtn
                .or(emptyCartText)
                .waitFor({ state: "visible", timeout: 6000 })
                .catch(() => { });
              currentUrl = flipkartPage.url();
            }

            // Double check that we are indeed on the cart page now
            if (!currentUrl.includes("/viewcart")) {
              console.log(
                `[Automation Tracking] ERROR: Failed to navigate back to cart page.`,
              );
              throw new Error(
                "Failed to navigate back to cart page after redirection",
              );
            }

            // Check if cart became empty (unavailability / cart reset)
            const emptyText = flipkartPage
              .locator('text="Your cart is empty!"')
              .first();
            if (
              await emptyText.isVisible({ timeout: 1500 }).catch(() => false)
            ) {
              console.log(
                `[Automation Tracking] ERROR: Cart is empty (likely item unavailable or reset).`,
              );
              throw new Error("Cart is empty (item unavailable or cart reset)");
            }

            console.log(
              `[Automation Tracking] Wait and verification complete. Moving to Place Order...`,
            );
          } else {
            console.log(
              `[Automation Tracking] ERROR: Address not found in the list.`,
            );
            throw new Error(
              `Address for ${currentRecord.name} not found in the list`,
            );
          }
        }
        await flipkartPage.waitForTimeout(3000);

        try {
          let placeOrderBtn = null;
          const yellowBtnWithSpace = flipkartPage
            .locator('div[style*="background-color: rgb(255, 194, 0)"]')
            .first();
          const yellowBtnNoSpace = flipkartPage
            .locator('div[style*="background-color:rgb(255,194,0)"]')
            .first();
          const textBtn = flipkartPage.locator("text=/Place Order/i").first();

          // Determine the best locator for yellow/standard Place Order button
          if (
            await yellowBtnWithSpace
              .isVisible({ timeout: 2000 })
              .catch(() => false)
          ) {
            placeOrderBtn = yellowBtnWithSpace;
            console.log(
              `[Automation Tracking] Found Place Order button by style (with space).`,
            );
          } else if (
            await yellowBtnNoSpace
              .isVisible({ timeout: 1000 })
              .catch(() => false)
          ) {
            placeOrderBtn = yellowBtnNoSpace;
            console.log(
              `[Automation Tracking] Found Place Order button by style (no space).`,
            );
          } else {
            placeOrderBtn = textBtn;
            console.log(
              `[Automation Tracking] Using fallback text-based Place Order button.`,
            );
          }

          console.log(`[Automation Tracking] Clicking Place Order button...`);

          let isClicked = false;
          for (let i = 0; i < 5; i++) {
            try {
              await placeOrderBtn.waitFor({ state: "visible", timeout: 2000 });
              await placeOrderBtn.click({ timeout: 2000 });
              isClicked = true;
              break;
            } catch (err) {
              console.log(
                `[Automation Tracking] Attempt ${i + 1} to click Place Order failed (maybe covered by loader). Retrying...`,
              );
              await delay(1000);
            }
          }

          if (!isClicked) {
            console.log(
              `[Automation Tracking] Standard click failed after 5 attempts. Trying force click...`,
            );
            await placeOrderBtn.click({ force: true, timeout: 2000 });
          }

          console.log(`[Automation Tracking] Clicked Place Order button.`);
          await emitLiveLog(
            currentRecord,
            "Placed order from cart. Navigating to checkout...",
            "inprogress",
            io,
          );

          const continueBtn = flipkartPage.locator("text=/Continue/i").first();
          // Wait for Continue button to load dynamically
          await continueBtn
            .waitFor({ state: "visible", timeout: 6000 })
            .catch(() => { });

          await emitLiveLog(
            currentRecord,
            "Clicking Continue...",
            "inprogress",
            io,
          );
          await continueBtn.click({ timeout: 5000 });

          // Wait for payment page to load — wait for COD option to appear
          const codOption = flipkartPage
            .locator('[data-disabled="false"]:has-text("Cash on Delivery")')
            .first();
          await codOption
            .waitFor({ state: "visible", timeout: 8000 })
            .catch(() => { });
          console.log(
            `[Automation Tracking] Payment page loaded. COD option visible.`,
          );

          // Check if COD is disabled (data-disabled="true")
          const codDisabled = flipkartPage
            .locator('[data-disabled="true"]:has-text("Cash on Delivery")')
            .first();
          if (
            await codDisabled.isVisible({ timeout: 1000 }).catch(() => false)
          ) {
            throw new Error("Cash on Delivery is not available for this order");
          }

          // Check for advance payment requirement
          const advancePayText = flipkartPage
            .locator("text=/pay.*advance|advance.*payment/i")
            .first();
          if (
            await advancePayText.isVisible({ timeout: 1000 }).catch(() => false)
          ) {
            const msg = await advancePayText
              .innerText()
              .catch(() => "Advance payment required");
            throw new Error(`COD requires advance payment: ${msg}`);
          }

          // Click COD option
          await emitLiveLog(
            currentRecord,
            "Selecting Cash on Delivery...",
            "inprogress",
            io,
          );
          await codOption.click({ force: true, timeout: 5000 });
          console.log(`[Automation Tracking] COD clicked.`);

          // Click Place Order button
          const codPlaceOrderBtn = flipkartPage
            .locator('[data-testid="payButton"], #cod-place-order')
            .first();
          await codPlaceOrderBtn.waitFor({ state: "visible", timeout: 5000 });
          await emitLiveLog(
            currentRecord,
            "Placing COD order...",
            "inprogress",
            io,
          );
          await codPlaceOrderBtn.click({ force: true, timeout: 5000 });
          console.log(`[Automation Tracking] Place Order clicked.`);

          // Click Confirm order button
          const confirmOrderBtn = flipkartPage
            .locator('button:has-text("Confirm order")')
            .first();
          await confirmOrderBtn.waitFor({ state: "visible", timeout: 6000 });
          await emitLiveLog(
            currentRecord,
            "Confirming order...",
            "inprogress",
            io,
          );
          await confirmOrderBtn.click({ force: true, timeout: 5000 });
          console.log(
            `[Automation Tracking] Confirm order clicked. Waiting for success page...`,
          );

          // Wait for success URL (reduce timeout to avoid hanging if no reference_id)
          let orderId = "";
          try {
            await flipkartPage.waitForURL(
              (url) => {
                const urlStr = typeof url === 'string' ? url : url.toString();
                return urlStr.includes('reference_id') || urlStr.includes('/order') || urlStr.includes('/checkout');
              },
              { timeout: 8000 }
            );
          } catch (_) { }

          // Extract reference_id from current URL
          try {
            const currentPageUrl = flipkartPage.url();
            console.log(`[Automation Tracking] Current URL after order: ${currentPageUrl}`);
            const urlObj = new URL(currentPageUrl);
            const referenceId = urlObj.searchParams.get('reference_id') || urlObj.searchParams.get('order_id');
            if (referenceId) {
              orderId = `${referenceId}00`;
              console.log(`[Automation Tracking] Order ID extracted: ${orderId}`);
            } else {
              // Try regex fallback on raw URL string
              const match = currentPageUrl.match(/(?:reference_id|order_id)=([^&]+)/);
              if (match && match[1]) {
                orderId = `${match[1]}00`;
                console.log(`[Automation Tracking] Order ID from regex: ${orderId}`);
              }
            }
          } catch (urlErr) {
            console.warn(`[Automation Tracking] Could not parse order URL: ${urlErr.message}`);
          }

          // Wait for success text including "Thanks for shopping" from screenshot
          await flipkartPage
            .locator('text=/Order Placed|Thank you|Order Confirmed|Successfully|Thanks for shopping/i')
            .first()
            .waitFor({ state: 'visible', timeout: 5000 })
            .catch(() => { console.warn('[Automation Tracking] Success text not found.'); });

          // Now take screenshot of success page
          ensureScreenshotsDir();
          const screenshotPath = `screenshots/product-success-${currentRecord.email}-${orderId || "no-order-id"}-${Date.now()}.png`;
          await flipkartPage.screenshot({
            path: screenshotPath,
            fullPage: false,
          });
          console.log(
            `[Automation Tracking] Screenshot saved: ${screenshotPath}`,
          );

          currentRecord.completedAt = new Date();
          currentRecord.screenshot = screenshotPath;
          currentRecord.addressSaved = true;
          if (orderId) {
            currentRecord.orderId = orderId;
            currentRecord.markModified('orderId');
          }
          currentRecord.status = 'success';
          currentRecord.reason = `Successfully confirmed COD order.${orderId ? ` Order ID: ${orderId}` : ''}`;
          await safeSaveRecord(currentRecord);
          console.log(`[Automation Tracking] Record saved with orderId: ${orderId}`);

          if (io) {
            io.emit('live-log', {
              jobId: currentRecord.jobId,
              email: currentRecord.email,
              name: currentRecord.name,
              message: currentRecord.reason,
              status: 'success'
            });
            io.emit('job-update', { type: 'email-update', jobId: currentRecord.jobId });
          }
          console.log(`✅ [Automation] DB saved — ${currentRecord.email} - ${currentRecord.name} (Confirmed Order${orderId ? `, Order ID: ${orderId}` : ''})`);
        } catch (e) {
          const cleanMsg = e.message.split("\n")[0].substring(0, 100);
          await failRecord(
            currentRecord,
            flipkartPage,
            "product-failed",
            cleanMsg,
            io,
          );
        }
      } else if (await notifyMeBtn.isVisible().catch(() => false)) {
        await failRecord(
          currentRecord,
          flipkartPage,
          "product-failed",
          "Notify Me",
          io,
        );
      } else {
        await failRecord(
          currentRecord,
          flipkartPage,
          "product-failed",
          "Add to cart button not found",
          io,
        );
      }
    }
  } catch (error) {
    console.error(
      `❌ [Automation] Error: ${primaryRecord.email} — ${error.message}`,
    );
    let screenshotPath = "";
    try {
      if (flipkartPage) {
        ensureScreenshotsDir();
        screenshotPath = `screenshots/purchase-failed-${primaryRecord.email}-${Date.now()}.png`;
        await flipkartPage.screenshot({
          path: screenshotPath,
          fullPage: false,
        });
      }
    } catch (_) { }

    for (const r of records) {
      if (r.status === "pending" || r.status === "inprogress") {
        r.completedAt = new Date();
        if (screenshotPath) r.screenshot = screenshotPath;
        await emitLiveLog(r, error.message, "failed", io);
      }
    }
  } finally {
    try {
      if (flipkartBrowser) await flipkartBrowser.close();
    } catch (_) { }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Automation Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export const runFlipkartAutomation = async (
  jobId,
  userId,
  runHeadless = true,
  io = null,
  targetRecordId = null,
) => {
  console.log(
    `🟢 [Automation] Starting Job "${jobId}" | Headless: ${runHeadless} | Concurrency: ${CONCURRENCY}`,
  );

  const checkJob = await AutomationJob.findById(jobId);
  if (!checkJob) {
    console.error("[Automation] Job not found");
    return;
  }

  const isPurchase = checkJob.type === "purchase";

  let emailContext = null;
  if (!isPurchase) {
    const emailArgs = BROWSER_ARGS.filter((a) => a !== "--incognito");
    try {
      emailContext = await chromium.launchPersistentContext("./kuku-session", {
        headless: runHeadless,
        args: emailArgs,
        viewport: { width: 1366, height: 768 },
        userAgent: USER_AGENT,
      });
      console.log("[Automation] Shared kuku.lu email context launched.");
    } catch (ctxErr) {
      console.error(
        "[Automation] Failed to launch email context:",
        ctxErr.message,
      );
      await AutomationJob.updateOne(
        { _id: jobId, userId },
        {
          status: "failed",
          reason: `Failed to launch email browser: ${ctxErr.message}`,
        },
      );
      if (io) {
        io.emit("job-update", {
          jobId,
          type: "status-change",
          status: "failed",
        });
      }
      return;
    }
  }

  // Reset any stuck inprogress records to pending before starting the loop
  const resetQuery = { jobId, status: "inprogress" };
  if (targetRecordId) {
    resetQuery._id = Array.isArray(targetRecordId)
      ? { $in: targetRecordId }
      : targetRecordId;
  }
  await Purchase.updateMany(resetQuery, {
    status: "pending",
    reason: "Reset from previous run",
  });

  let hasMoreToProcess = true;
  while (hasMoreToProcess) {
    const query = { jobId, status: "pending" };
    if (targetRecordId) {
      query._id = Array.isArray(targetRecordId)
        ? { $in: targetRecordId }
        : targetRecordId;
    }

    const emails = await Purchase.find(query).sort({ _id: 1 });

    if (emails.length === 0) {
      break;
    }

    console.log(
      `[Automation] Found ${emails.length} pending email(s) to process. Type: ${checkJob.type}`,
    );

    await AutomationJob.updateOne(
      { _id: jobId, userId },
      {
        status: "running",
        reason: `Processing ${emails.length} email(s) with ${CONCURRENCY} parallel workers...`,
      },
    );
    if (io) {
      io.emit("job-update", {
        jobId,
        type: "status-change",
        status: "running",
      });
    }

    const recordsByEmail = {};
    for (const record of emails) {
      if (!recordsByEmail[record.email]) recordsByEmail[record.email] = [];
      recordsByEmail[record.email].push(record);
    }
    const emailGroups = Object.values(recordsByEmail);

    for (let i = 0; i < emailGroups.length; i += CONCURRENCY) {
      const currentJob = await AutomationJob.findById(jobId);
      if (!currentJob || currentJob.status === "stopped") {
        console.log(`🛑 [Automation] Stop signal detected. Halting.`);
        hasMoreToProcess = false;
        break;
      }

      const batch = emailGroups.slice(i, i + CONCURRENCY);
      console.log(
        `[Automation] Processing batch ${Math.floor(i / CONCURRENCY) + 1}...`,
      );

      const promises = batch.map((group) => {
        if (isPurchase) {
          return processPurchase(group, jobId, runHeadless, io);
        } else {
          return processLogin(group, emailContext, jobId, runHeadless, io);
        }
      });

      await Promise.all(promises);

      if (io) io.emit("job-update", { type: "batch-complete", jobId });
    }

    if (targetRecordId) break; // Don't loop if we are only targeting a single record
  }

  // ── Close shared email context ───────────────────────────────────────────
  if (emailContext) {
    try {
      await emailContext.close();
      console.log("[Automation] Shared email context closed.");
    } catch (_) { }
  }

  // ── Finalize job status ──────────────────────────────────────────────────
  const finalJob = await AutomationJob.findById(jobId);
  if (finalJob) {
    // Cleanup any stuck inprogress records
    const cleanupResult = await Purchase.updateMany(
      { jobId, status: "inprogress" },
      {
        status: "pending",
        reason: "Stopped by user before completion",
        screenshot: "",
      },
    );

    if (finalJob.status !== "stopped") {
      const pendingCount = await Purchase.countDocuments({
        jobId,
        status: "pending",
      });
      const failedCount = await Purchase.countDocuments({
        jobId,
        status: "failed",
      });
      const successCount = await Purchase.countDocuments({
        jobId,
        status: "success",
      });

      if (pendingCount === 0) {
        if (failedCount > 0 && successCount === 0) {
          finalJob.status = "failed";
          finalJob.completedAt = new Date();
          finalJob.reason = `All ${failedCount} attempt(s) failed.`;
        } else if (failedCount > 0) {
          finalJob.status = "completed";
          finalJob.completedAt = new Date();
          finalJob.reason = `Completed with ${successCount} success, ${failedCount} failed.`;
        } else {
          finalJob.status = "completed";
          finalJob.completedAt = new Date();
          finalJob.reason = `All ${successCount} execution(s) completed successfully! 🎉`;
        }
      } else {
        finalJob.status = "stopped";
        finalJob.completedAt = new Date();
        finalJob.reason = "Execution stopped before all emails were processed.";
      }
      await safeSaveRecord(finalJob);
    }

    if (io) {
      io.emit("job-update", {
        jobId,
        type: "status-change",
        status: finalJob.status,
      });
      io.emit("live-log-clear", { jobId });
    }
  }

  console.log(`🏁 [Automation] Job "${jobId}" finished.`);
};
