import { chromium } from "playwright";
import fs from "fs";
import AutomationJob from "../models/AutomationJob.js";
import CancelOrder from "../models/CancelOrder.js";
import LoginEmail from "../models/LoginEmail.js";
import { delay } from "./utils.js";

const CONCURRENCY = parseInt(process.env.CANCEL_CONCURRENCY) || 1;

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-blink-features=AutomationControlled",
  "--disable-geolocation",
  "--disable-notifications",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ensureScreenshotsDir = () => {
  if (!fs.existsSync("screenshots"))
    fs.mkdirSync("screenshots", { recursive: true });
};

/** Safe DB save — retries on VersionError with fresh document */
const safeSaveRecord = async (record) => {
  try {
    await record.save();
  } catch (err) {
    if (err.name === "VersionError") {
      const fresh = await record.constructor.findById(record._id);
      if (fresh) {
        for (const path of record.modifiedPaths()) fresh[path] = record[path];
        await fresh.save();
      }
    } else {
      throw err;
    }
  }
};

/**
 * updateTask — atomically update task fields via findByIdAndUpdate (no parallel save conflict)
 * Returns updated document.
 */
const updateTask = async (taskId, fields) => {
  return await CancelOrder.findByIdAndUpdate(
    taskId,
    { $set: fields },
    { new: true },
  );
};

/** Emit live log to socket only — no DB save */
const emitLiveLog = (io, task, message) => {
  if (!io) return;
  io.emit("cancel-live-log", {
    jobId: task.jobId,
    email: task.email,
    orderId: task.orderId,
    message,
    status: task.status,
  });
  io.emit("cancel-job-update", { type: "record-update", jobId: task.jobId });
};

/** Fail a task — take screenshot, update DB atomically, emit socket */
const failRecord = async (taskId, taskMeta, page, reason, io) => {
  let screenshotPath = "";
  try {
    if (page) {
      ensureScreenshotsDir();
      screenshotPath = `screenshots/cancel-failed-${taskMeta.email}-${Date.now()}.png`;
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch(() => {});
    }
  } catch (_) {}

  const fields = {
    status: "failed",
    reason,
    completedAt: new Date(),
    ...(screenshotPath && { screenshot: screenshotPath }),
  };
  await updateTask(taskId, fields);

  if (io) {
    io.emit("cancel-live-log", {
      jobId: taskMeta.jobId,
      email: taskMeta.email,
      orderId: taskMeta.orderId,
      message: reason,
      status: "failed",
    });
    io.emit("cancel-job-update", {
      type: "record-update",
      jobId: taskMeta.jobId,
    });
  }
  console.log(
    `❌ [Cancel] Failed — ${taskMeta.email} | ${taskMeta.orderId} | ${reason}`,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Process a single cancel task
// ─────────────────────────────────────────────────────────────────────────────
const processCancelTask = async (task, jobId, runHeadless, io) => {
  let browser = null;
  let page = null;

  // taskMeta holds non-changing fields for socket emits
  const taskMeta = {
    jobId: task.jobId,
    email: task.email,
    orderId: task.orderId,
  };

  try {
    const loginSession = await LoginEmail.findOne({
      email: task.email,
      status: "success",
    });

    if (!loginSession) {
      await failRecord(
        task._id,
        taskMeta,
        null,
        `No saved login session found for ${task.email}`,
        io,
      );
      return;
    }

    // Mark inprogress atomically
    await updateTask(task._id, {
      status: "inprogress",
      reason: "Starting cancel automation...",
    });
    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      "Starting cancel automation...",
    );

    browser = await chromium.launch({
      headless: runHeadless,
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (s, e) => {
            if (e) e({ code: 1, message: "Disabled." });
          },
          watchPosition: (s, e) => {
            if (e) e({ code: 1, message: "Disabled." });
          },
        },
      });
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

    if (loginSession.cookies?.length > 0) {
      await context.addCookies(loginSession.cookies);
    }

    page = await context.newPage();
    await page.goto("https://www.flipkart.com", {
      waitUntil: "domcontentloaded",
    });

    if (
      loginSession.localStorage &&
      Object.keys(loginSession.localStorage).length > 0
    ) {
      await page.evaluate((ls) => {
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
      }, loginSession.localStorage);
    }

    if (
      loginSession.sessionStorage &&
      Object.keys(loginSession.sessionStorage).length > 0
    ) {
      await page.evaluate((ss) => {
        for (const [k, v] of Object.entries(ss)) sessionStorage.setItem(k, v);
      }, loginSession.sessionStorage);
    }

    // Stop signal check
    const jobCheck = await AutomationJob.findById(jobId);
    if (!jobCheck || jobCheck.status === "stopped") {
      console.log(`🛑 [Cancel] Job stopped before processing ${task.email}`);
      await updateTask(task._id, {
        status: "pending",
        reason: "Stopped before processing",
      });
      return;
    }

    // Build cancel URL
    const itemId = task.orderId.slice(-18);
    const unitId = `${itemId}000`;
    const cancelUrl = `https://www.flipkart.com/orders/cancelOrder?grocery=false&itemId=${itemId}&orderId=${task.orderId}&unitId=${unitId}`;

    console.log(`[Cancel] Navigating to: ${cancelUrl}`);
    await updateTask(task._id, {
      reason: `Navigating to cancel page for Order: ${task.orderId}`,
    });
    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      `Navigating to cancel page...`,
    );

    await page.goto(cancelUrl, { waitUntil: "domcontentloaded" });
    await delay(2000);

    // ── Check: "Something's not right!" ──
    const isSomethingWrong = await page
      .locator("text=Something's not right!")
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (isSomethingWrong) {
      ensureScreenshotsDir();
      const ssPath = `screenshots/cancel-already-${task.email}-${task.orderId}-${Date.now()}.png`;
      await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
      const reason = `Already cancelled or not eligible. Order ID: ${task.orderId}`;
      await updateTask(task._id, {
        status: "failed",
        reason,
        screenshot: ssPath,
        completedAt: new Date(),
      });
      emitLiveLog(io, { ...taskMeta, status: "failed" }, reason);
      console.log(
        `⚠️ [Cancel] Already cancelled — ${task.email} | ${task.orderId}`,
      );
      return;
    }

    // ── Check: session expired ──
    if (page.url().includes("/account/login")) {
      await failRecord(
        task._id,
        taskMeta,
        page,
        "Session expired. Please re-login.",
        io,
      );
      return;
    }

    await updateTask(task._id, {
      reason: "Cancel page loaded. Selecting reason...",
    });
    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      "Cancel page loaded. Selecting reason...",
    );

    // ── Step 1: Select reason ──
    const reasonSelect = page.locator('select[name="reasonList"]');
    await reasonSelect.waitFor({ state: "visible", timeout: 8000 });

    if (task.reasonvalue) {
      await reasonSelect.selectOption({ value: task.reasonvalue });
      console.log(`[Cancel] Reason selected: "${task.reasonvalue}"`);
      await delay(600);
    } else {
      const firstValue = await reasonSelect
        .locator("option:not([disabled])")
        .first()
        .getAttribute("value");
      if (firstValue) await reasonSelect.selectOption({ value: firstValue });
      await delay(600);
    }

    // ── Step 2: Fill textarea ──
    if (task.reasontext) {
      emitLiveLog(
        io,
        { ...taskMeta, status: "inprogress" },
        "Filling cancellation comment...",
      );
      const textarea = page.locator("textarea").first();
      const textVisible = await textarea
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (textVisible) {
        await textarea.click();
        await textarea.fill(task.reasontext);
        await delay(400);
      }
    }

    // ── Step 3: Click CONTINUE ──
    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      "Clicking CONTINUE...",
    );
    const continueBtn = page.locator("button.dSM5Ub").first();
    await continueBtn.waitFor({ state: "visible", timeout: 5000 });
    await page
      .waitForFunction(
        () => !document.querySelector("button.dSM5Ub")?.disabled,
        { timeout: 5000 },
      )
      .catch(() => {});
    await continueBtn.click({ force: true });
    console.log(`[Cancel] CONTINUE clicked.`);

    // ── Step 4: COD radio + Request Cancellation ──
    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      "Selecting cancellation option...",
    );
    const codRadio = page.locator('label[for="COD"]');
    await codRadio.waitFor({ state: "visible", timeout: 6000 });
    await codRadio.click();
    await delay(600);

    emitLiveLog(
      io,
      { ...taskMeta, status: "inprogress" },
      "Clicking Request Cancellation...",
    );
    const requestCancelBtn = page
      .locator('button:has-text("Request Cancellation")')
      .first();
    await requestCancelBtn.waitFor({ state: "visible", timeout: 5000 });
    await requestCancelBtn.click({ force: true });
    console.log(`[Cancel] Request Cancellation clicked.`);

    // ── Step 5: Wait 2s ──
    await delay(3000);

    // ── Step 6: Screenshot ──
    ensureScreenshotsDir();
    const screenshotPath = `screenshots/cancel-success-${task.email}-${task.orderId}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[Cancel] Screenshot saved: ${screenshotPath}`);

    // ── Step 7: Mark SUCCESS ──
    const successReason = `Order cancelled successfully. Order ID: ${task.orderId} | Reason: ${task.reasonvalue || "N/A"}`;
    await updateTask(task._id, {
      status: "success",
      reason: successReason,
      screenshot: screenshotPath,
      completedAt: new Date(),
    });
    emitLiveLog(io, { ...taskMeta, status: "success" }, successReason);
    console.log(`✅ [Cancel] Success — ${task.email} | Order: ${task.orderId}`);
  } catch (error) {
    const cleanMsg = error.message.split("\n")[0].substring(0, 120);
    await failRecord(task._id, taskMeta, page, cleanMsg, io);
  } finally {
    try {
      if (browser) await browser.close();
    } catch (_) {}
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Cancel Automation Entry Point
// ─────────────────────────────────────────────────────────────────────────────
export const runCancelAutomation = async (
  jobId,
  userId,
  runHeadless = true,
  io = null,
) => {
  console.log(
    `🟢 [Cancel] Starting Job "${jobId}" | Headless: ${runHeadless} | Concurrency: ${CONCURRENCY}`,
  );

  const job = await AutomationJob.findById(jobId);
  if (!job) {
    console.error("[Cancel] Job not found");
    return;
  }

  // Reset stuck inprogress from previous run
  await CancelOrder.updateMany(
    { jobId, status: "inprogress" },
    { status: "pending", reason: "Reset from previous run" },
  );

  let hasMore = true;
  while (hasMore) {
    const tasks = await CancelOrder.find({ jobId, status: "pending" }).sort({
      _id: 1,
    });
    if (tasks.length === 0) break;

    console.log(`[Cancel] Found ${tasks.length} pending task(s).`);

    await AutomationJob.updateOne(
      { _id: jobId, userId },
      {
        status: "running",
        reason: `Processing ${tasks.length} cancel task(s)...`,
      },
    );
    if (io)
      io.emit("cancel-job-update", {
        type: "status-change",
        jobId,
        status: "running",
      });

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const currentJob = await AutomationJob.findById(jobId);
      if (!currentJob || currentJob.status === "stopped") {
        console.log(`🛑 [Cancel] Stop signal detected. Halting.`);
        hasMore = false;
        break;
      }

      const batch = tasks.slice(i, i + CONCURRENCY);
      console.log(`[Cancel] Batch ${Math.floor(i / CONCURRENCY) + 1}...`);
      await Promise.all(
        batch.map((task) => processCancelTask(task, jobId, runHeadless, io)),
      );
      if (io) io.emit("cancel-job-update", { type: "batch-complete", jobId });
    }

    break;
  }

  // ── Finalize ──
  const finalJob = await AutomationJob.findById(jobId);
  if (finalJob && finalJob.status !== "stopped") {
    await CancelOrder.updateMany(
      { jobId, status: "inprogress" },
      { status: "pending", reason: "Stopped before completion" },
    );

    const pendingCount = await CancelOrder.countDocuments({
      jobId,
      status: "pending",
    });
    const failedCount = await CancelOrder.countDocuments({
      jobId,
      status: "failed",
    });
    const successCount = await CancelOrder.countDocuments({
      jobId,
      status: "success",
    });

    if (pendingCount === 0) {
      finalJob.status =
        failedCount > 0 && successCount === 0 ? "failed" : "completed";
      finalJob.reason =
        failedCount > 0 && successCount === 0
          ? `All ${failedCount} cancel attempt(s) failed.`
          : failedCount > 0
            ? `Completed with ${successCount} success, ${failedCount} failed.`
            : `All ${successCount} cancel order(s) processed successfully! 🎉`;
    } else {
      finalJob.status = "stopped";
      finalJob.reason = "Execution stopped before all tasks were processed.";
    }

    finalJob.completedAt = new Date();
    await safeSaveRecord(finalJob);
  }

  if (io) {
    io.emit("cancel-job-update", {
      jobId,
      type: "status-change",
      status: finalJob?.status,
    });
    io.emit("cancel-live-log-clear", { jobId });
  }

  console.log(`🏁 [Cancel] Job "${jobId}" finished.`);
};
