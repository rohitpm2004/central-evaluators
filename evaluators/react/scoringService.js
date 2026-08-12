import { generateAIFeedback } from "./utils/aiFeedback.js";
import logger from "../../config/logger.js";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

let client = null;

function getGroqClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — AI scoring will fail.");
    return null;
  }
  client = new OpenAI({
    apiKey,
  });
  return client;
}

/**
 * Recursively reads .js, .jsx, .ts, .tsx files from a directory,
 * ignoring node_modules, dist, build, .git, and .css to save tokens.
 */
async function readProjectFiles(dir, fileList = []) {
  const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "public", "assets"]);
  const ALLOWED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]); // Ignoring .css for token savings

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await readProjectFiles(filePath, fileList);
      }
    } else if (ALLOWED_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Compresses source code to drastically reduce AI token usage.
 */
function compressCode(code) {
  // Remove block comments (/* ... */) and single-line comments (// ...)
  let compressed = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  // Remove empty lines and excessive indentation
  compressed = compressed.replace(/^\s*[\r\n]/gm, "");
  compressed = compressed.replace(/[ \t]{2,}/g, " ");
  return compressed;
}

/**
 * Reads all relevant source files from the student project and returns
 * a concatenated string for AI analysis.
 *
 * @param {string} projectPath - Path to the cloned student repo
 * @returns {Promise<string>} - Concatenated compressed code string
 */
async function getProjectCodeString(projectPath) {
  // Try src/ first, then fall back to root
  const srcDir = path.join(projectPath, "src");
  let files = [];
  try {
    files = await readProjectFiles(srcDir);
  } catch {
    // No src/ directory, try root
  }

  if (files.length === 0) {
    files = await readProjectFiles(projectPath);
  }

  // Cap at 15 files to avoid token overflow
  files = files.slice(0, 15);

  if (files.length === 0) {
    return "";
  }

  let codeStr = "";
  for (const f of files) {
    const relativePath = path.relative(projectPath, f);
    try {
      const content = await fs.readFile(f, "utf8");
      const compressed = compressCode(content);
      // Cap each file at 2000 compressed chars to be ultra token efficient
      codeStr += `\n--- ${relativePath} ---\n${compressed.slice(0, 2000)}\n`;
    } catch {
      // Skip unreadable files
    }
  }

  return codeStr;
}

/**
 * Scores a React submission using AI-based code analysis.
 * Reads the student's actual source code and evaluates each rubric criterion
 * using Groq AI.
 *
 * @param {Object} rubric      - { criteria: [{ name, weight, description }] }
 * @param {string} projectPath - Path to the cloned student repo
 * @param {string} githubReport - Build/Linter report from GitHub Actions
 * @returns {Promise<Object>}  - Standard evaluation output
 */
export default async function scoreSubmission(rubric, projectPath, githubReport) {
  const warnings = [];

  // Step 1: Read the student's code (compressed for tokens)
  const codeString = await getProjectCodeString(projectPath);

  if (!codeString) {
    logger.warn("No source files found in student repo.");
    const breakdown = {};
    for (const c of rubric.criteria) {
      breakdown[c.name] = 0;
    }
    const feedback = await generateAIFeedback({
      rubric_breakdown: breakdown,
      score: 0,
      warnings: ["No source files found in the repository."],
      execution_logs: githubReport || "",
    });
    return {
      score: 0,
      rubric_breakdown: breakdown,
      feedback,
      warnings: ["No source files found in the repository."],
      execution_logs: githubReport || "",
      status: "fail",
    };
  }

  // Step 2: Build the rubric criteria description for the AI prompt
  const criteriaList = rubric.criteria
    .map(
      (c, i) =>
        `${i + 1}. "${c.name}" (weight: ${c.weight} points): ${c.description || "No description provided."}`
    )
    .join("\n");

  // Step 3: Ask AI to score each criterion
  const groq = getGroqClient();
  let breakdown = {};
  let totalScore = 0;

  if (!groq) {
    // If no AI client, give half credit for having code (better than 0)
    logger.warn("Groq client unavailable — defaulting to partial credit.");
    for (const c of rubric.criteria) {
      breakdown[c.name] = Math.round(c.weight * 0.5);
      totalScore += breakdown[c.name];
    }
    warnings.push("AI scoring unavailable — default partial credit assigned.");
  } else {
    const prompt = `You are an expert React instructor grading a student's assignment.

## GitHub Actions Build/Linter Report:
${githubReport || "No build report available."}

## Student's Compressed Source Code:
${codeString}

## Rubric Criteria to Evaluate:
${criteriaList}

## Instructions:
For EACH rubric criterion listed above, carefully analyze the student's code and determine how well they met the requirement.

Assign a score multiplier between 0.0 and 1.0 for each criterion:
- 1.0 = Fully meets the criterion
- 0.7-0.9 = Mostly meets it with minor issues
- 0.4-0.6 = Partially meets it
- 0.1-0.3 = Barely attempted
- 0.0 = Not attempted at all

Output STRICTLY a JSON object with this exact format (no markdown, no extra text):
{
  "scores": [
    { "name": "<exact criterion name>", "multiplier": <number between 0.0 and 1.0>, "reasoning": "<1 sentence>" }
  ]
}`;

    try {
      logger.info("Sending code to Groq AI for rubric-based scoring...");

      const response = await groq.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content?.trim();
      logger.info(`Groq AI response received: ${rawContent?.slice(0, 200)}...`);

      const parsed = JSON.parse(rawContent);

      if (parsed.scores && Array.isArray(parsed.scores)) {
        for (const scoredCriteria of parsed.scores) {
          const matchingRubric = rubric.criteria.find(
            (c) => c.name.toLowerCase() === scoredCriteria.name?.toLowerCase()
          );

          if (matchingRubric) {
            const multiplier =
              typeof scoredCriteria.multiplier === "number"
                ? Math.max(0, Math.min(1, scoredCriteria.multiplier))
                : 0;
            const score = Math.round(matchingRubric.weight * multiplier);
            breakdown[matchingRubric.name] = score;
            totalScore += score;

            if (scoredCriteria.reasoning) {
              logger.info(
                `  "${matchingRubric.name}": ${score}/${matchingRubric.weight} — ${scoredCriteria.reasoning}`
              );
            }
          }
        }
      }

      // Fill in any criteria that the AI missed
      for (const c of rubric.criteria) {
        if (breakdown[c.name] === undefined) {
          warnings.push(
            `AI did not return a score for "${c.name}" — defaulting to 0.`
          );
          breakdown[c.name] = 0;
        }
      }
    } catch (err) {
      logger.error(`AI scoring failed: ${err.message}`);
      warnings.push(`AI scoring error: ${err.message}`);
      // Fallback: give half credit for having code
      for (const c of rubric.criteria) {
        breakdown[c.name] = Math.round(c.weight * 0.5);
        totalScore += breakdown[c.name];
      }
    }
  }

  const maxScore = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
  const status = totalScore >= maxScore * 0.5 ? "pass" : "fail";

  // Step 4: Generate human-readable AI feedback
  logger.info(`Generating feedback for total score: ${totalScore}/${maxScore}`);
  const feedback = await generateAIFeedback({
    rubric_breakdown: breakdown,
    score: totalScore,
    warnings,
    execution_logs: githubReport || "",
  });

  return {
    score: totalScore,
    rubric_breakdown: breakdown,
    feedback,
    warnings,
    execution_logs: githubReport || "",
    status,
  };
}