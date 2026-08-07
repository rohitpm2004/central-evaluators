import Groq from "groq-sdk";

// V-42: lazy init so a missing GROQ_API_KEY doesn't crash the server at boot.
let _groq;
function getGroq() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

export async function validateScriptWithAI({ studentCode, expectedLogs, actualLogs }) {
  try {
    const prompt = `
You are a senior JavaScript developer acting as an automated evaluator.
You are evaluating a student's JavaScript script assignment. 
The student's script produced some output logs, but they did not strictly match the expected output. 

Your task is to determine if the student's code conceptually satisfies the requirements for EACH expected output log. 
You must be flexible and mark it as 'true' (passed) if the mismatch is purely due to harmless reasons such as:
- Adding conversational text (e.g. 'Result: 5' instead of '5')
- Using custom mock data (e.g. using their own name/age instead of 'John Doe')
- Minor formatting or spacing differences.

However, if the underlying calculation, logic, or data type is genuinely incorrect, or if the student completely missed a concept, mark it as 'false' (failed).

---
STUDENT'S SOURCE CODE:
\`\`\`javascript
${studentCode}
\`\`\`

EXPECTED OUTPUT LOGS (What the assignment strictly asked for):
${JSON.stringify(expectedLogs, null, 2)}

ACTUAL OUTPUT LOGS (What the student's code actually printed):
${JSON.stringify(actualLogs, null, 2)}
---

Respond ONLY with a valid JSON array of booleans (e.g., [true, false, true]). 
The array length MUST exactly match the length of the EXPECTED OUTPUT LOGS array. 
Do not include any explanation or markdown formatting like \`\`\`json. Return only the raw array.
`;

    const completion = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    });

    const responseText = completion.choices[0].message.content.trim();
    
    // Parse the response, stripping any markdown wrappers if the LLM hallucinated them
    const cleanJson = responseText.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
    
    const result = JSON.parse(cleanJson);
    
    if (Array.isArray(result) && result.length === expectedLogs.length) {
      return result;
    } else {
      console.error("[AI VALIDATION] LLM returned invalid array length or non-array.");
      return null;
    }

  } catch (err) {
    console.error("[AI VALIDATION ERROR]", err);
    return null;
  }
}
