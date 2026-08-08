import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { evaluateFullstackProject } from "../evaluators/fullstack/evaluatorService.js"


let fullstackWorker = null;

export async function initializeFullstackWorker() {
  try {
    logger.info('Initializing Fullstack Worker...');

    const jsQueue = queueManager.getQueue('fullstack');
    const config = queueManager.getConfig('fullstack');

    fullstackWorker = new Worker(
      'fullstack-evaluation',
      async (job) => {
        try {
          logger.info(`Starting Fullstack evaluation: ${job.id}`);
          const results = await evaluateFullstackProject(job.data); // V-41: must await
          logger.info(`Fullstack Job ${job.id} completed`);
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