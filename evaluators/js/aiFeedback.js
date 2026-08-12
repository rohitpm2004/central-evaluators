import OpenAI from "openai";
import logger from "../../config/logger.js";

let client = null;

function getClient() {
  if (client) return client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("OPENAI_API_KEY not set — AI feedback will be skipped.");
    return null;
  }

  client = new OpenAI({
    apiKey,
  });

  logger.info("OpenAI client initialised for JS Evaluator.");
  return client;
}

/**
 * Attempts to fetch the raw student code from a GitHub URL.
 * If it's a full repo instead of a single file, this might fail, which is okay.
 */
async function fetchStudentCode(repoUrl) {
  if (!repoUrl) return "No repository URL provided.";
  try {
    let rawUrl = repoUrl;
    // Convert github.com blob URLs to raw.githubusercontent.com
    if (repoUrl.includes("github.com") && repoUrl.includes("/blob/")) {
      rawUrl = repoUrl
        .replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/");
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(rawUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const data = await response.text();
    // Cap at 2000 chars to save tokens
    return data.slice(0, 2000);
  } catch (err) {
    logger.warn(`Failed to fetch student code for AI feedback: ${err.message}`);
    return "Code could not be automatically fetched.";
  }
}

/**
 * Generates AI-assisted feedback for a student's JavaScript submission.
 *
 * @param {Object} jobData      - The raw BullMQ job data containing testCases, expectedLogs, etc.
 * @param {Object} githubResult - The result returned from the GitHub Action { passed, score, feedback }
 * @returns {Promise<string>}   - A JSON stringified object matching the FeedbackCell structure
 */
export async function generateJSAIFeedback(jobData, githubResult) {
  const openai = getClient();
  const { score, feedback: rawFeedback } = githubResult;

  // 1. 100% Bypass Logic
  if (score === 100) {
    return JSON.stringify({
      summary: "Excellent work! You successfully passed all requirements.",
      strengths: ["All required functionality was implemented correctly.", "Code executed without errors and matched all expected outputs."],
      issues: []
    });
  }

  // Fall back to plain string if OpenAI is not configured
  if (!openai) {
    return rawFeedback;
  }

  // 2. Fetch Context for the AI
  const studentCode = await fetchStudentCode(jobData.submission?.repoUrl);
  
  let requirements = "No specific requirements provided.";
  if (jobData.evaluationMode === "function") {
    requirements = `Function Mode: Expected to write a function named '${jobData.entryFunction}'.\nTest Cases:\n${JSON.stringify(jobData.testCases, null, 2)}`;
  } else {
    requirements = `Script Mode: Expected Console Logs:\n${JSON.stringify(jobData.expectedLogs, null, 2)}`;
  }

  // 3. Build the Prompt
  const prompt = `
You are a Javascript coding instructor reviewing a student's assignment.

## Assignment Requirements:
${requirements}

## Student's Code (first 2000 chars):
\`\`\`javascript
${studentCode}
\`\`\`

## Automated Evaluation Result:
Score: ${score}/100
Raw Grader Feedback: ${rawFeedback}

Write constructive, encouraging feedback for the student based on why they failed (e.g. syntax error, didn't match logs, wrong function output).
Do NOT mention the numeric score.

Output STRICTLY a JSON object with this exact format (no markdown, no extra text):
{
  "summary": "1-2 sentences summarizing their attempt.",
  "strengths": ["1 thing they did well, even if they failed"],
  "issues": ["1-2 things that need fixing based on the raw feedback/code"]
}
`.trim();

  try {
    logger.info("Sending JS code to OpenAI for feedback generation...");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.6,
      response_format: { type: "json_object" },
    });

    const feedbackJsonString = response.choices[0]?.message?.content?.trim();
    logger.info("AI feedback received from OpenAI.");
    
    // Validate it parses correctly, if not, throw to fallback
    JSON.parse(feedbackJsonString);
    
    return feedbackJsonString;
  } catch (err) {
    logger.error("OpenAI API call failed for JS feedback:", err.message);
    // Fall back gracefully
    return rawFeedback;
  }
}
