import logger from '../config/logger.js';
import redisConnection from '../config/redis.js';

export const handleGithubWebhook = async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
      logger.warn(`Unauthorized webhook attempt for job ${req.body?.jobId}`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { jobId, status } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId in payload" });
    }

    logger.info(`Received GitHub webhook for job: ${jobId} with status: ${status}`);

    // Publish the entire result to the Redis channel that the worker is listening on
    const publisher = redisConnection.getClient();
    await publisher.publish(
      `github_webhook_${jobId}`,
      JSON.stringify(req.body)
    );

    return res.status(200).json({ success: true, message: "Webhook processed" });
  } catch (error) {
    logger.error(`Error processing GitHub webhook: ${error.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
};
