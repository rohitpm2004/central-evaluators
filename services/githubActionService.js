import logger from '../config/logger.js';

/**
 * Triggers the GitHub Actions Grader workflow.
 * @param {string} repoUrl - The student's repository URL.
 * @param {string} jobId - The unique BullMQ job ID.
 * @param {string} webhookUrl - The URL GitHub should ping when done.
 */
export const triggerGraderWorkflow = async (repoUrl, jobId, webhookUrl, eventType = 'run-evaluation', extraPayload = {}) => {
  const username = process.env.GITHUB_USERNAME;
  const token = process.env.GITHUB_PAT;
  const repoName = 'async-grader';

  if (!username || !token) {
    throw new Error("GitHub credentials (GITHUB_USERNAME, GITHUB_PAT) are missing in .env");
  }

  const apiUrl = `https://api.github.com/repos/${username}/${repoName}/dispatches`;

  logger.info(`Triggering GitHub Action for repo: ${repoUrl} (Job: ${jobId}, Event: ${eventType})`, { service: 'github-service' });

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_type: eventType,
          client_payload: {
            repoUrl,
            jobId,
            webhookUrl,
            webhookSecret: process.env.WEBHOOK_SECRET,
            ...extraPayload
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API Error: ${response.status} - ${errorText}`);
      }

      logger.info(`Successfully triggered GitHub Action for Job: ${jobId} (Attempt ${attempt + 1})`, { service: 'github-service' });
      return; // Success, exit the function
    } catch (error) {
      attempt++;
      logger.error(`Failed to trigger GitHub Action on attempt ${attempt}: ${error.message}`, { service: 'github-service' });
      
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Failed to trigger GitHub Action after ${MAX_RETRIES} attempts. Last error: ${error.message}`);
      }
      
      // Wait for 2 seconds (with exponential backoff) before retrying
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
};
