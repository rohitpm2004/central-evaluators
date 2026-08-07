// executionService.js

// TODO(security, V-34): vm2 is deprecated and has known sandbox-escape CVEs.
// Migrate JS execution to isolated-vm or an E2B sandbox. See VISUAL_EVALUATOR_AUDIT.md V-34.
import { VM } from "vm2";
import { validateScriptWithAI } from "./aiValidationService.js";

// Author: Arma Sahar
// vm2's own `timeout` option (below, 1000ms) only bounds *synchronous*
// execution inside a single vm.run() call — it does nothing for
// async/await, since control returns to Node's event loop while waiting.
// Without a separate cap, a student function that awaits a promise that
// never settles (e.g. `await new Promise(() => {})`) would hang this test
// case forever. This is that separate, async-aware ceiling.
const ASYNC_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Async execution timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runJavaScript({
  studentCode,
  evaluationMode,
  entryFunction,
  testCase,
  expectedLogs
}) {

  const logs = [];

  // Author: Arma Sahar
  // Bug (jsBugs.md #13): `setTimeout` wasn't defined in the sandbox at all,
  // so the extremely common "simulate async work" pattern
  // (`await new Promise(r => setTimeout(r, ms))`) threw ReferenceError —
  // and since that throw happens inside a Promise executor, it doesn't
  // surface as a normal synchronous error, it becomes an *unhandled promise
  // rejection* after this function has already returned. Fix: give the
  // sandbox a real setTimeout/clearTimeout (delegating to Node's own), but
  // track every timer it creates so we can force-clear them once this test
  // case is done grading — otherwise a student `setTimeout(fn, 999999)`
  // would keep a stale VM context alive in Node's event loop indefinitely.
  const pendingTimers = new Set();
  const sandboxSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(fn, ms, ...args);
    pendingTimers.add(id);
    return id;
  };
  const sandboxClearTimeout = (id) => {
    clearTimeout(id);
    pendingTimers.delete(id);
  };

  // Author: Arma Sahar
  // Bug (jsBugs.md #10): the sandbox only defined `console`, so any student
  // file ending in the extremely common Node/CommonJS convention
  // `module.exports = { foo };` threw "module is not defined" — which
  // aborted the ENTIRE run (see the try/catch below), failing every test
  // case even though the function itself was correct. Fix: give the
  // sandbox inert `module`/`exports` objects so that line is a harmless
  // no-op (we always call the entry function by name, never through
  // module.exports, so we don't need it to do anything real). `require`
  // gets a stub that throws a clear message instead of a confusing
  // ReferenceError, since there's no real module resolution in-sandbox.
  //
  // `fetch` is deliberately a stub too, not real network access: letting
  // arbitrary student-submitted code make outbound HTTP requests from the
  // grading server is an SSRF/abuse vector, so "API calls" inside graded
  // functions aren't supported — same reasoning as `require`.
  const vm = new VM({
    timeout: 1000,
    sandbox: {
      console: {
        log: (...args) => {
          logs.push(args.join(" "));
        }
      },
      module: { exports: {} },
      exports: {},
      require: () => {
        throw new Error(
          "require() is not available in the grading sandbox — only code within this file is evaluated."
        );
      },
      fetch: () => {
        throw new Error(
          "fetch() is not available in the grading sandbox — network access isn't permitted for graded code."
        );
      },
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout
    }
  });

  try {

    vm.run(studentCode);

    // -------------------------
    // FUNCTION MODE
    // -------------------------
    if (evaluationMode === "function") {

      if (!entryFunction) {

    return {
      passed: false,
      error:
        "entryFunction required for function mode"
    };
  }

      // Author: Arma Sahar
      // Bug (jsBugs.md #3): this always spread `testCase.input`, assuming
      // every test case's input is an args array. The repo's own fixture
      // (config/testCases.js) uses a scalar input (e.g. `input: -1`), so
      // `...(-1)` threw "not iterable" and every such test case silently
      // failed. Fix: only spread when input is actually an array; otherwise
      // pass it as the single argument the function expects.
      const args = Array.isArray(testCase.input)
        ? testCase.input
        : [testCase.input];

      let result = vm.run(`
        ${entryFunction}(
          ...${JSON.stringify(args)}
        )
      `);

      // Author: Arma Sahar
      // Bug (jsBugs.md #13): `async function`s and Promise-returning
      // functions were graded synchronously — `result` was always the
      // pending Promise object itself (which JSON.stringifies to "{}"),
      // never its resolved value, so every async entry function failed
      // regardless of correctness. Fix: await it (bounded by
      // ASYNC_TIMEOUT_MS, see above) before comparing.
      if (result && typeof result.then === "function") {
        result = await withTimeout(Promise.resolve(result), ASYNC_TIMEOUT_MS);
      }

      const passed =
        JSON.stringify(result) ===
        JSON.stringify(testCase.expected);

      return {
        passed,
        actual: result,
        expected: testCase.expected,
        logs
      };
    }

    // -------------------------
    // SCRIPT MODE
    // -------------------------

    if (evaluationMode === "script") {
      const normalizedActual = logs.map((v) => String(v).trim());
      const normalizedExpected = expectedLogs.map((v) => String(v).trim());
      
      let matched = 0;
      let failures = [];
      let strictMatched = true;

      for (let i = 0; i < normalizedExpected.length; i++) {
        const expected = normalizedExpected[i];
        const actual = normalizedActual[i];
        if (actual === expected) {
          matched++;
        } else {
          strictMatched = false;
          failures.push({
            logNumber: i + 1,
            expected,
            actual,
          });
        }
      }

      // If strict match fails, fallback to AI Validation
      if (!strictMatched && normalizedActual.length > 0) {
        const aiResults = await validateScriptWithAI({
          studentCode,
          expectedLogs: normalizedExpected,
          actualLogs: normalizedActual,
        });

        if (aiResults) {
          // Recompute matched and failures based on AI results
          matched = 0;
          failures = [];
          for (let i = 0; i < normalizedExpected.length; i++) {
            if (aiResults[i]) {
              matched++;
            } else {
              failures.push({
                logNumber: i + 1,
                expected: normalizedExpected[i],
                actual: normalizedActual[i] || undefined,
                aiNote: "AI determined this output did not conceptually match expectations.",
              });
            }
          }
        }
      }

      return {
        passed: matched === normalizedExpected.length,
        matched,
        total: normalizedExpected.length,
        failures,
        actual: normalizedActual,
        expected: normalizedExpected,
      };
    } else {
  return {
    passed: false,
    error:
      "Unsupported evaluation mode"
  };
}
  } catch (err) {
    return {
      passed: false,
      error: err.message
    };
  } finally {
    // Author: Arma Sahar — force-clear any timers the student's code
    // scheduled but that never fired (e.g. a huge delay, or one still
    // pending when ASYNC_TIMEOUT_MS won the race), so nothing keeps this
    // VM context alive in Node's event loop after grading moves on.
    for (const id of pendingTimers) clearTimeout(id);
  }
}
