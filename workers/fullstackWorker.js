import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { evaluateReactProject as evaluateFullstackProject } from "../evaluators/react/evaluatorService.js";
import { webhookPubSub } from '../services/webhookPubSub.js';

let fullstackWorker = null;

export async function initializeFullstackWorker() {
  try {
    logger.info('Initializing Fullstack Worker...');

    const config = queueManager.getConfig('fullstack');

    fullstackWorker = new Worker(
      'fullstack-evaluation',
      async (job) => {
        try {
          logger.info(`Starting Fullstack evaluation: ${job.id}`);
          
          // Phase 1: Dispatch to GitHub Actions
          const githubResult = await withTimeout(
            (async () => {
              const webhookPromise = webhookPubSub.waitForWebhook(job.id, config.timeout);
              
              const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
              const repoUrl = job.data.repoUrl || job.data.submission_link;
              await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-fullstack-evaluation');
              
              return await webhookPromise;
            })(),
            config.timeout,
            `fullstack-eval-github ${job.id}`
          );

          // Phase 2: Handle GitHub result
          if (githubResult.status !== 'completed' || (githubResult.testOutput || '').toLowerCase().includes('build: failed')) {
            logger.info(`Fullstack Job ${job.id} failed build on GitHub Actions.`);
            return {
              score: 0,
              feedback: `Your application failed to build. Linter/Build Report:\n\n${githubResult.testOutput || 'Unknown Build Error'}`,
              details: []
            };
          }

          // Phase 3: Token-optimized AI Scoring
          logger.info(`GitHub Action completed successfully for Fullstack Job ${job.id}. Proceeding to AI rubric evaluation.`);
          const githubReport = githubResult.testOutput || 'Build and Linter Passed.';
          const results = await evaluateFullstackProject(job.data, job.id, githubReport); // passing report
          
          logger.info(`Fullstack Job ${job.id} completed entirely.`);
          return { success: true, results };
        } catch (err) {
          logger.error(`Fullstack Job ${job.id} failed`, err);
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
    fullstackWorker.on('completed', (job, result) => {
      logger.info(`Fullstack Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    fullstackWorker.on('failed', (job, err) => {
      logger.error(`FullStack Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('Fullstack Worker initialized');
    return fullstackWorker;

  } catch (err) {
    logger.error('Failed to initialize Fullstack worker:', err);
    throw err;
  }
}

export async function stopFullstackWorker() {
  try {
    if (fullstackWorker) {
      await fullstackWorker.close();
    }
    logger.info('Fullstack worker stopped');
  } catch (err) {
    logger.error('Error stopping Fullstack worker:', err);
  }
}

export function getFullstackWorkerStatus() {
  return {
    status: fullstackWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('fullstack').concurrency
  };
}

export { fullstackWorker };