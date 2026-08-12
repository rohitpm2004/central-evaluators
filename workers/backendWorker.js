import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { evaluateBackendProject } from '../evaluators/backend/evaluatorService.js';
import { webhookPubSub } from '../services/webhookPubSub.js';

let backendWorker = null;

export async function initializeBackendWorker() {
  try {
    logger.info('Initializing Backend Worker...');

    const config = queueManager.getConfig('backend');

    backendWorker = new Worker(
      'backend-evaluation',
      async (job) => {
        try {
          logger.info(`Starting Backend evaluation: ${job.id}`);
          
          const results = await withTimeout(
            (async () => {
              // Phase 1: Wait for webhook & Dispatch to GitHub Actions
              // We set up the listener FIRST to avoid race conditions if GitHub returns instantly
              const webhookPromise = webhookPubSub.waitForWebhook(job.id, config.timeout);
              
              const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
              const repoUrl = job.data.repoUrl || job.data.submission_link;
              await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-backend-evaluation');
              
              // Now await the result
              const githubResult = await webhookPromise;

              // Phase 2: Handle GitHub result
              if (githubResult.status !== 'completed' || !githubResult.testOutput) {
                logger.info(`Backend Job ${job.id} failed on GitHub Actions or returned no code.`);
                return {
                  score: 0,
                  feedback: `Evaluation workflow failed to retrieve source code or encountered an error.\n\n${githubResult.testOutput || 'Unknown Error'}`,
                  rubric_breakdown: []
                };
              }

              // Phase 3: Token-optimized AI Scoring
              logger.info(`GitHub Action completed successfully for Backend Job ${job.id}. Proceeding to AI rubric evaluation.`);
              const githubCodeContext = githubResult.testOutput;
              return await evaluateBackendProject(job.data, job.id, githubCodeContext);
            })(),
            config.timeout,
            `backend-eval-job ${job.id}`
          );
          
          logger.info(`Backend Job ${job.id} completed entirely.`);
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
      logger.info(`Backend Job ${job.id} completed`, {
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