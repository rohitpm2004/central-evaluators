/**
 * Requires: GROQ_API_KEY in .env file
 */
import Grok from "groq-sdk";
import OpenAI from "openai";
import logger from "../../../config/logger.js";
import fs from "fs/promises";
import path from "path";

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    logger.warn("GROQ_API_KEY not set — AI feedback will be skipped.");
    return null;
  }

  // Groq is OpenAI API-compatible — just point baseURL to Groq's endpoint
  client = new OpenAI({
    apiKey,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });

  logger.info("Groq client initialised.");
  return client;
}

/**
 * Generates AI-assisted feedback for a student's React submission.
 *
 * @param {Object} params
 * @param {Object} params.rubric_breakdown  - { criteriaName: score, ... }
 * @param {number} params.score             - Total score achieved
 * @param {string[]} params.warnings        - Warning messages from scorer
 * @param {string} params.execution_logs    - Raw build/test logs
 *
 * @returns {Promise<string>} feedback - A constructive paragraph of feedback
 */
export async function generateAIFeedback({ rubric_breakdown, score, warnings, execution_logs }) {
  const openai = getClient();

  // Fall back to rule-based summary if Groq is not configured
  if (!openai) {
    return buildFallbackFeedback(rubric_breakdown, score, warnings);
  }

  // Build a concise criteria summary for the prompt
  const criteriaLines = Object.entries(rubric_breakdown)
    .map(([name, points]) =>
      `- ${name}: ${points > 0 ? `PASSED (${points} pts)` : "FAILED (0 pts)"}`
    )
    .join("\n");

  const failedItems = warnings.join("; ") || "None";

  // Trim logs to avoid exceeding token limits
  const logSnippet = execution_logs
    ? execution_logs.slice(-1500)
    : "No logs available.";

  const prompt = `
You are a coding instructor reviewing a student's React assignment submission.

Here are the automated evaluation results:
Score: ${score}/100

Criteria Results:
${criteriaLines}

Issues Detected:
${failedItems}

Relevant Execution Logs (last 1500 chars):
${logSnippet}

Write 2–3 sentences of constructive, encouraging feedback for the student.
- Mention what they did well (passed criteria).
- Clearly point out what needs improvement (failed criteria).
- Suggest one actionable improvement tip.
- Do NOT mention the score number. Keep it friendly and educational.
`.trim();

  try {
    logger.debug("Sending prompt to Groq...");

    const response = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",   // Stable Groq model
      messages: [{ role: "user", content: prompt }],
      max_tokens: 250,
      temperature: 0.6,
    });

    const feedback = response.choices[0]?.message?.content?.trim();
    logger.info("AI feedback received from Groq.");
    return feedback || buildFallbackFeedback(rubric_breakdown, score, warnings);

  } catch (err) {
    logger.error("Groq API call failed:", err.message);
    // Never let AI failure break evaluation — fall back gracefully
    return buildFallbackFeedback(rubric_breakdown, score, warnings);
  }
}

/**
 * Rule-based fallback feedback used when Groq is unavailable or fails.
 *
 * @param {Object} rubric_breakdown
 * @param {number} score
 * @param {string[]} warnings
 * @returns {string}
 */
function buildFallbackFeedback(rubric_breakdown, score, warnings) {
  const passed = Object.entries(rubric_breakdown)
    .filter(([, pts]) => pts > 0)
    .map(([name]) => name);

  const failed = Object.entries(rubric_breakdown)
    .filter(([, pts]) => pts === 0)
    .map(([name]) => name);

  if (failed.length === 0) {
    return "Great work! All criteria passed successfully. Your React application is well-structured and functional.";
  }

  const passedStr = passed.length > 0
    ? `You successfully implemented: ${passed.join(", ")}. `
    : "";
  const failedStr = `The following areas need attention: ${failed.join(", ")}. `;
  const tip = "Review the failing criteria and ensure your components, state management, and routing are correctly implemented.";

  return passedStr + failedStr + tip;
}

/**
 * Recursively reads .js and .jsx files from a directory, ignoring node_modules/dist/build.
 */
async function readProjectFiles(dir, fileList = []) {
  const files = await fs.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && file !== 'build') {
        await readProjectFiles(filePath, fileList);
      }
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Uses Groq AI to read the actual React code files and grade their structure.
 */
export async function evaluateCodeStructure(projectPath) {
  const openai = getClient();
  if (!openai) return { scoreMultiplier: 1, reasoning: "AI offline, granted full credit." };

  try {
    const srcDir = path.join(projectPath, "src");
    let files = [];
    try {
      files = await readProjectFiles(srcDir);
    } catch {
      try { files = await readProjectFiles(projectPath); } catch { files = []; }
    }

    // Limit to 6 main files to save tokens
    files = files.slice(0, 6);
    if (files.length === 0) return { scoreMultiplier: 0, reasoning: "No source files found." };

    let codeStr = "";
    for (const f of files) {
      const relativePath = path.relative(projectPath, f);
      const content = await fs.readFile(f, "utf8");
      codeStr += `\n--- ${relativePath} ---\n${content.slice(0, 2000)}\n`;
    }

    const prompt = `
You are an expert React instructor grading the "Code Structure" portion of an assignment.
Read these main files from the student's submission:
${codeStr}

Evaluate component breakdown, hook usage, and React best practices.
Output STRICTLY a JSON object:
{
  "scoreMultiplier": <number strictly between 0.0 and 1.0 representing percentage grade>,
  "reasoning": "<1 sentence explanation on what was good or bad>"
}
Do NOT include any markdown or text besides the raw JSON object.
`.trim();

    const response = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(response.choices[0].message.content.trim());
    return {
      scoreMultiplier: typeof parsed.scoreMultiplier === "number" ? parsed.scoreMultiplier : 1,
      reasoning: parsed.reasoning || ""
    };
  } catch (err) {
    logger.error("Code structure evaluation failed:", err.message);
    return { scoreMultiplier: 1, reasoning: "Evaluation errored, defaulting to full credit." };
  }
}