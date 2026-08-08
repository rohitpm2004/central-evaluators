import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
// import { evaluateJavaScript } from '../evaluators/javascript/evaluatorService.js';
import { cloneRepo, deleteRepo } from "../evaluators/python/repoService.js";
import { findPythonFiles } from "../evaluators/python/fileService.js";
import { evaluateAll } from "../evaluators/python/evaluator.js";

let pythonWorker = null;

export async function initializePythonWorker() {
  try {
    logger.info('Initializing python Worker...');

    const jsQueue = queueManager.getQueue('python');
    const config = queueManager.getConfig('python');

    pythonWorker = new Worker(
      'python-evaluation',
      async (job) => {
          let repoPath;
          try {
            logger.info(`Starting Python evaluation: ${job.id}`);
            const { repoUrl } = job.data;
            // 1. Clone repo
            repoPath = await cloneRepo(repoUrl);
            // 2. Find python files
            const students = findPythonFiles(repoPath);
            // 3. Evaluate
            const results = await evaluateAll(students);
            // const results = await evaluateJavaScript(job.data);
            logger.info(`Python Job ${job.id} completed`);
            return { success: true, results };
          } catch (err) {
            logger.error(`Python Job ${job.id} failed`, err);
            throw err;
          } finally {
            if (repoPath) {
              await deleteRepo(repoPath);
              logger.info(`[PYTHON WORKER] deleted temp repo: ${repoPath}`);
            }
          }
      },
      {
        connection: redisConnection.getClient().duplicate(), // V-13: dedicated blocking connection per worker
        concurrency: config.concurrency,
        settings: {
          maxStalledCount: 2,
          lockDuration: 30000,
          lockRenewTime: 15000
        }
      }
    );

    // Event handlers
    pythonWorker.on('completed', (job, result) => {
      logger.info(`Python Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    pythonWorker.on('failed', (job, err) => {
      logger.error(`Python Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('Python Worker initialized');
    return pythonWorker;

  } catch (err) {
    logger.error('Failed to initialize Python worker:', err);
    throw err;
  }
}

export async function stopPythonWorker() {
  try {
    if (pythonWorker) {
      await pythonWorker.close();
    }
    logger.info('Python worker stopped');
  } catch (err) {
    logger.error('Error stopping Python worker:', err);
  }
}

export function getPythonWorkerStatus() {
  return {
    status: pythonWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('python').concurrency
  };
}

export { pythonWorker };