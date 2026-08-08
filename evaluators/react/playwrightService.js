import { spinTestEnvironment, execCommand, execCommandDetached, enforceTimeout } from "./sandboxService.js";
import runPlaywrightTests from "./playwrightTests.js";

/**
 * Runs the full evaluation pipeline:
 * 1. Spin up an isolated E2B Cloud Sandbox
 * 2. npm install → npm run build → serve the built app
 * 3. Run Playwright UI tests against the public E2B URL
 * 4. Return structured test results + full execution logs
 *
 * @param {string} projectPath         - Absolute path to the cloned project directory
 * @returns {Object} { components, props, state, routing, api, logs }
 */
export default async function runTests(projectPath) {

  // Spin up sandbox — returns the sandbox instance, the public app URL, and the actual project directory
  const { sandbox, appUrl, projectDir } = await spinTestEnvironment(projectPath);

  // Auto-kill after 5 minutes to prevent runaway processes
  enforceTimeout(sandbox, 300000);

  const executionLogs = [];

  try {
    // ── Step 1: Install dependencies ──────────────────────────────────────
    console.log("Cleaning sandbox node_modules if they exist...");
    try {
      // Sometimes unzip creates folders with restrictive permissions.
      // We try to chmod before rm to ensure we can delete it.
      await execCommand(sandbox, "chmod -R u+w node_modules || true", projectDir);
      await execCommand(sandbox, "rm -rf node_modules", projectDir);
    } catch (e) {
      console.log("Ignored node_modules cleanup error:", e.message);
    }

    console.log("Installing dependencies inside sandbox...");
    try {
      // E2B commands implicitly capture stdout/stderr in our e2bManager wrapper
      const installLogs = await execCommand(sandbox, "npm install --prefer-offline --ignore-scripts 2>&1 || true", projectDir);
      executionLogs.push("=== npm install ===\n" + installLogs);
    } catch (err) {
      executionLogs.push(`=== npm install FAILED ===\n${err.message}`);
      return createFailResult(executionLogs, "Dependency installation failed. Check package.json.");
    }

    // ── Step 2: Build the React project ───────────────────────────────────
    console.log("Building React project...");
    let buildLogs;
    try {
      buildLogs = await execCommand(sandbox, "npm run build 2>&1", projectDir);
      executionLogs.push("=== npm run build ===\n" + buildLogs);
      
      // If build outputs obvious error strings, treat as failure
      if (buildLogs.toLowerCase().includes("err!") || buildLogs.includes("Command failed")) {
        return createFailResult(executionLogs, "Build failed. Check syntax and compilation errors.");
      }
    } catch (err) {
      executionLogs.push(`=== npm run build FAILED ===\n${err.message}`);
      return createFailResult(executionLogs, "Build script failed to execute. Check syntax and compilation errors.");
    }

    // Detect build output folder (Vite → /dist, CRA → /build)
    const buildFolder = await detectBuildFolder(sandbox, projectDir);
    executionLogs.push(`=== Build folder detected: ${buildFolder} ===`);

    // ── Step 3: Serve built app on container port 3000 ────────────────────
    console.log(`Serving app from /${buildFolder} on container port 3000 at ${appUrl}...`);
    await execCommandDetached(
      sandbox,
      `python3 -m http.server 3000 --directory ${buildFolder}`, 
      projectDir
    );
    
    // Give the server a moment to start before running Playwright
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ── Step 4: Run Playwright tests on the host using the mapped port ────
    console.log(`Running Playwright tests against ${appUrl} ...`);
    const { results, logs: playwrightLogs } = await runPlaywrightTests(appUrl);
    executionLogs.push("=== Playwright Tests ===\n" + playwrightLogs.join("\n"));

    return {
      ...results,   // { components, props, state, routing, api }
      logs: executionLogs.join("\n\n"),
    };

  } catch (error) {
    // Top-level sandbox failure (e.g. timeout)
    executionLogs.push(`=== Sandbox Error ===\n${error.message}`);
    return createFailResult(executionLogs, `Fatal execution error: ${error.message}`);
  } finally {
    // Always stop the sandbox
    try { await sandbox.kill(); } catch { /* already stopped */ }
  }
}

/**
 * Returns a 0-score test result object when the build or install step fails gracefully.
 */
function createFailResult(executionLogs, failMessage) {
  executionLogs.push(`\n[FATAL] ${failMessage}`);
  return {
    components: false,
    props: false,
    state: false,
    routing: false,
    api: false,
    logs: executionLogs.join("\n\n"),
  };
}

/**
 * Detects whether the project built to /dist (Vite) or /build (CRA).
 * Falls back to "dist" if neither is found.
 *
 * @param {object} sandbox - Sandbox instance
 * @param {string} projectDir - The directory where the project is built
 * @returns {Promise<string>} - "dist" | "build"
 */
async function detectBuildFolder(sandbox, projectDir = "/home/user/app") {
  const check = await execCommand(
    sandbox,
    "[ -d dist ] && echo dist || ([ -d build ] && echo build || echo dist)",
    projectDir
  );
  return check.trim();
}