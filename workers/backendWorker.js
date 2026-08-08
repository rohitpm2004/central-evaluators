import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';


let backendWorker = null;

export async function initializeBackendWorker() {
  try {
    logger.info('Initializing Backend Worker...');

    const jsQueue = queueManager.getQueue('backend');
    const config = queueManager.getConfig('backend');

    backendWorker = new Worker(
      'backend-evaluation',
      async (job) => {
        try {
          logger.info(`Starting Backend evaluation: ${job.id}`);
          // Bug (backendBugs.md #8): unlike visualWorker.js, this call was
          // never wrapped in withTimeout. A hung sandbox command (stalled
          // `npm install`, a student server that never exits, an infinite
          // loop under test) would block this worker slot forever — with
          // concurrency 3, three such jobs stall the entire backend queue
          // for everyone behind them, with no automatic recovery.
          const results = await withTimeout(
            new Promise((resolve, reject) => {
              const subscriber = redisConnection.getClient().duplicate();
              let timeoutId;
              
              subscriber.subscribe(`github_webhook_${job.id}`, async (err) => {
                if (err) {
                  await subscriber.quit();
                  return reject(err);
                }
                
                // Explicit timeout to prevent Redis connection leaks
                timeoutId = setTimeout(async () => {
                  await subscriber.quit();
                  reject(new Error("GitHub Actions webhook timeout"));
                }, config.timeout);
                
                try {
                  const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
                  const repoUrl = job.data.repoUrl || job.data.submission_link;
                  await triggerGraderWorkflow(repoUrl, job.id, webhookUrl);
                } catch (e) {
                  clearTimeout(timeoutId);
                  await subscriber.quit();
                  return reject(e);
                }
              });

              subscriber.on('message', async (channel, message) => {
                if (channel === `github_webhook_${job.id}`) {
                  clearTimeout(timeoutId);
                  await subscriber.quit();
                  try {
                    const payload = JSON.parse(message);
                    if (payload.status === 'completed') {
                      const score = (payload.testOutput || '').toLowerCase().includes('fail') ? 0 : 100;
                      resolve({
                        score: score,
                        feedback: payload.testOutput || 'Evaluation completed successfully.'
                      });
                    } else {
                      reject(new Error("GitHub Actions job failed or cancelled"));
                    }
                  } catch (parseErr) {
                    reject(parseErr);
                  }
                }
              });
            }),
            config.timeout,
            `backend-eval ${job.id}`
          );
          logger.info(`Backend Job ${job.id} completed`);
          return { success: true, results };
        } catch (err) {
          logger.error(`Backend Job ${job.id} failed`, err);
          throw err;
        }
      },
      {
        connection: redisConnection.getClient(),
        concurrency: config.concurrency,
        settings: {
          maxStalledCount: 2,
          lockDuration: 30000,
          lockRenewTime: 15000
        }
      }
    );

    // Event handlers
    backendWorker.on('completed', (job, result) => {
      logger.info(`JS Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    backendWorker.on('failed', (job, err) => {
      logger.error(`Backend Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('Backend Worker initialized');
    return backendWorker;

  } catch (err) {
    logger.error('Failed to initialize Backend worker:', err);
    throw err;
  }
}

export async function stopBackendWorker() {
  try {
    if (backendWorker) {
      await backendWorker.close();
    }
    logger.info('Backend worker stopped');
  } catch (err) {
    logger.error('Error stopping Backend worker:', err);
  }
}

export function getBackendWorkerStatus() {
  return {
    status: backendWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('backend').concurrency
  };
}

export { backendWorker };