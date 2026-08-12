import OpenAI from 'openai';
import logger from '../../config/logger.js';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set - Backend AI feedback will fail.');
    return null;
  }
  client = new OpenAI({ apiKey });
  return client;
}

export async function evaluateBackendProject(jobData, jobId, githubCodeContext) {
  const openai = getClient();
  if (!openai) {
    return {
      score: 0,
      feedback: "OpenAI API key is missing on the server. Cannot evaluate.",
      rubric_breakdown: []
    };
  }

  const { rubric } = jobData;
  const rubricText = rubric ? JSON.stringify(rubric, null, 2) : "Standard Grading";

  const prompt = `
You are an expert Backend (Node.js/Express/MongoDB) instructor evaluating a student's assignment.

## Rubric:
${rubricText}

## Student's Core Source Code:
${githubCodeContext}

Please carefully analyze the attached source code and determine how well they met the rubric requirements.

**IMPORTANT GRADING INSTRUCTIONS:**
1. **Focus on Backend Logic:** Check for proper routing, controller logic, mongoose schemas/models, and error handling.
2. **Missing Files:** The code provided is a subset of the repository (only core .js files). If package.json or minor files are missing from the context, do not heavily penalize them.
3. **Database Connection:** Do not penalize if the .env file is missing, this is expected for security reasons.

Write constructive, encouraging feedback based on their code.
Do NOT mention the numeric score in the feedback text.

Output STRICTLY a JSON object with this exact format (no markdown, no extra text):
{
  "score": <number 0-100>,
  "summary": "1-2 sentences summarizing their attempt.",
  "strengths": ["1 thing they did well, especially regarding backend logic"],
  "issues": ["1-2 things that need fixing based on the rubric"],
  "rubric_breakdown": [
     { "criterion": "Name of criterion", "points_awarded": <number>, "max_points": <number>, "comment": "Brief comment" }
  ]
}
`.trim();

  try {
    logger.info(`Sending Backend code to OpenAI for job ${jobId}...`);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const resultStr = response.choices[0].message.content.trim();
    const resultObj = JSON.parse(resultStr);

    return {
      score: resultObj.score || 0,
      feedback: JSON.stringify({
        summary: resultObj.summary,
        strengths: resultObj.strengths || [],
        issues: resultObj.issues || []
      }),
      rubric_breakdown: resultObj.rubric_breakdown || []
    };

  } catch (err) {
    logger.error(`OpenAI API call failed for Backend feedback (Job: ${jobId}):`, err.message);
    return {
      score: 0,
      feedback: "Failed to generate AI feedback due to an internal server error.",
      rubric_breakdown: []
    };
  }
}