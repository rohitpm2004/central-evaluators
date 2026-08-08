import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
// import { evaluateReact } from '../evaluators/react/evaluatorService.js';
import { evaluateReactProject } from '../evaluators/react/evaluatorService.js';

let reactWorker = null;

export async function initializeReactWorker() {
  try {
    logger.info('Initializing React Worker...');

    const reactQueue = queueManager.getQueue('react');
    const config = queueManager.getConfig('react');

    reactWorker = new Worker(
      'react-evaluation',
      async (job) => {
        try {
          logger.info(`Starting React evaluation: ${job.id}`);
          const results = await evaluateReactProject(job.data);
          logger.info(`React Job ${job.id} completed`);
          return { success: true, results };
        } catch (err) {
          logger.error(`React Job ${job.id} failed`, err);
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
    reactWorker.on('completed', (job, result) => {
      logger.info(`React Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    reactWorker.on('failed', (job, err) => {
      logger.error(`React Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('React Worker initialized');
    return reactWorker;

  } catch (err) {
    logger.error('Failed to initialize React worker:', err);
    throw err;
  }
}

export async function stopReactWorker() {
  try {
    if (reactWorker) {
      await reactWorker.close();
    }
    logger.info('React worker stopped');
  } catch (err) {
    logger.error('Error stopping React worker:', err);
  }
}

export function getJsWorkerStatus() {
  return {
    status: reactWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('react').concurrency
  };
}

export { reactWorker };