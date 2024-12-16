const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  if (fs.existsSync(imagePath)) {
    const buffer = fs.readFileSync(imagePath);
    const resizedBuffer = await sharp(buffer)
      .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .toBuffer();
    fs.writeFileSync(imagePath, resizedBuffer);
  }
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  // Resize images to ensure they match the same size before comparison
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`));
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    console.error(`Failed to capture screenshot for ${url}:`, error);
  }
}

// Log result for each page in real-time
function logPageResult(pagePath, similarity, error = null) {
  if (error) {
    console.log(chalk.red(`[Error] Page: ${pagePath} - ${error}`));
  } else if (typeof similarity === "number") {
    const status =
      similarity >= 95 ? chalk.green("Pass") : chalk.red("Fail");
    console.log(
      `${status} Page: ${pagePath} - Similarity: ${similarity.toFixed(2)}%`
    );
  } else {
    console.log(
      chalk.yellow(`[Unknown] Page: ${pagePath} - ${similarity || "Unknown"}`)
    );
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background-color: #f2f2f2; }
        .thumbnail { max-width: 200px; max-height: 150px; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage >= 95
          ).length
        }</p>
        <p>Failed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage < 95
          ).length
        }</p>
        <p>Errors: ${
          results.filter((r) => r.similarityPercentage === "Error").length
        }</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Thumbnail</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(
      /\//g,
      "_"
    )}.png`;

    const statusClass =
      typeof result.similarityPercentage === "number" &&
      result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>${result.pagePath}</td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank"><img src="${diffThumbnailPath}" class="thumbnail" /></a>`
            : "Thumbnail not available"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Playwright Test Suite
test.describe("Visual Comparison Tests", () => {
  test.setTimeout(7200000);

  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue(`\nRunning visual tests for ${deviceName}`));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      const fullPath = path.join(baseDir, dir);
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        console.log(chalk.yellow(`\nTesting page: ${pagePath}`));

        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        logPageResult(pagePath, similarity);
        results.push({
          pagePath,
          similarityPercentage:
            typeof similarity === "number" ? similarity : similarity,
        });
      } catch (error) {
        logPageResult(pagePath, null, error.message);
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });
});
