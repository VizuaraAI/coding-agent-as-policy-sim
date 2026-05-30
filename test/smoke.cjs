const puppeteer = require("puppeteer");

const URL = process.env.SIM_URL || "http://127.0.0.1:8088/";
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--window-size=1280,860"
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".panel", { timeout: 10000 });
  // give app.js a moment to wire up + fetch the file list
  await new Promise((r) => setTimeout(r, 1500));

  // 1. The three "quick" fill buttons are gone.
  const quickCount = await page.$$eval(".quick button", (els) => els.length).catch(() => 0);
  check("no quick fill buttons", quickCount === 0, `found ${quickCount}`);

  // 2. "How this works" guide present.
  check("guide present", await page.$("details.guide") !== null);

  // 3. Working-directory viewer present.
  check("working-dir viewer present", await page.$("#calibFiles") !== null);

  // 4. File list shows top_down.json (server has one calibration file).
  const fileNames = await page.$$eval("#calibFiles .file-name", (els) => els.map((e) => e.textContent));
  check("lists top_down.json skill file", fileNames.includes("top_down.json"), JSON.stringify(fileNames));

  // 5. Execute stage auto-loads the execute prompt.
  await page.click("#stageExecute");
  await new Promise((r) => setTimeout(r, 250));
  const execVal = await page.$eval("#instruction", (el) => el.value);
  check("execute stage loads execute prompt", /drive the car to the green goal/i.test(execVal), execVal.slice(0, 60));

  // 6. Calibrate stage auto-loads the calibrate prompt.
  await page.click("#stageCalibrate");
  await new Promise((r) => setTimeout(r, 250));
  const calVal = await page.$eval("#instruction", (el) => el.value);
  check("calibrate stage loads calibrate prompt", /calibrate the active camera/i.test(calVal), calVal.slice(0, 60));

  // 7. Clicking a skill file opens its contents.
  if (fileNames.includes("top_down.json")) {
    await page.click("#calibFiles .file-item");
    await new Promise((r) => setTimeout(r, 400));
    const viewHidden = await page.$eval("#calibFileView", (el) => el.hidden);
    const viewText = await page.$eval("#calibFileView", (el) => el.textContent);
    check("file viewer opens content", !viewHidden && /vx_world_per_unit_s/.test(viewText), viewText.slice(0, 50));
  }

  // 8. Status sub-text reserves a fixed height (the anti-jump fix).
  const subH = await page.$eval(".status-sub", (el) => getComputedStyle(el).height);
  check("status-sub has fixed reserved height", parseFloat(subH) > 20, subH);

  // 9. Three camera buttons exist.
  const camCount = await page.$$eval(".camera-switch button", (els) => els.length);
  check("three camera buttons", camCount === 3, `found ${camCount}`);

  await page.screenshot({ path: "/tmp/sim_test.png", fullPage: false });
  check("no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(2); });
