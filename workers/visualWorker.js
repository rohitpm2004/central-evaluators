// src/workers/visualWorker.js
/**
 * Visual Evaluation Worker
 * 
 * Handles UI/Visual evaluations with:
 * - Browser pooling for efficiency
 * - Proper error handling
 * - Logging and monitoring
 * - Integration with new queueManager
 */

import { Worker, UnrecoverableError } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { evaluateStudentsWithVision } from '../evaluators/visual/evaluatorService.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let visualWorker = null;

// No longer requires BROWSER_POOL_SIZE as execution is offloaded.

/**
 * Initialize visual worker
 * Called once at application startup
 */
export async function initializeVisualWorker() {
  try {
    logger.info('Initializing Visual Worker...');

    // No longer initializing browser pool.

    // Get queue from queueManager
    const visualQueue = queueManager.getQueue('visual');
    const config = queueManager.getConfig('visual');

    // Create worker with proper concurrency
    visualWorker = new Worker(
      'visual-evaluation',
      async (job) => {
        return await processVisualJob(job);
      },
      {
        connection: redisConnection.getClient(), // V-13: BullMQ will duplicate this for the blocking client automatically
        concurrency: config.concurrency,  // 2 concurrent jobs
        settings: {
          maxStalledCount: 2,             // Allow 2 stalls before failing
          // V-19: visual jobs are long (2x goto + 2x GPT-4o). Lock must comfortably
          // exceed worst-case work; renew at half the lock.
          lockDuration: 180000,           // 3 min
          lockRenewTime: 60000,           // renew every 1 min
          retryProcessDelay: 5000         // Delay between retries
        }
      }
    );

    // Setup event handlers
    setupWorkerEvents();

    logger.info('Visual Worker initialized');
    logger.info(`Concurrency: ${config.concurrency}, Timeout: ${config.timeout}ms`);

    return visualWorker;

  } catch (err) {
    logger.error('Failed to initialize visual worker:', err);
    throw err;
  }
}

/**
 * Process a visual evaluation job
 */
async function processVisualJob(job) {
  const jobId = job.id;
  const config = queueManager.getConfig('visual');

  const {
    submission,
    rubricText,
    expectedUrl,
    assignmentId
  } = job.data;
  
  try {
    if (submission.ideFiles) {
      logger.info(`Starting visual evaluation locally for IDE submission: ${jobId}`);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-eval-'));
      for (const file of submission.ideFiles) {
        if (file.path && typeof file.content === 'string') {
          const filePath = path.join(tempDir, file.path);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, file.content, 'utf8');
        }
      }
      try {
        const result = await evaluateStudentsWithVision({
          jobId,
          assignmentId,
          studentId: submission.studentId,
          studentName: submission.studentName,
          repoPath: tempDir,
          rubricText,
          expectedUrl,
          entryFile: submission.entryFile
        });
        return { success: true, result };
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    logger.info(`Starting visual evaluation via GitHub Actions: ${jobId}`);
    
    const result = await withTimeout(
      new Promise((resolve, reject) => {
        const subscriber = redisConnection.getClient().duplicate();
        let timeoutId;
        
        subscriber.subscribe(`github_webhook_${jobId}`, async (err) => {
          if (err) {
            await subscriber.quit();
            return reject(err);
          }
          
          timeoutId = setTimeout(async () => {
            await subscriber.quit();
            reject(new Error("GitHub Actions webhook timeout"));
          }, config.timeout);
          
          try {
            const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
            const repoUrl = submission.repoUrl;
            const extraPayload = {
              rubricText,
              expectedUrl,
              assignmentId,
              studentId: submission.studentId,
              studentName: submission.studentName,
              entryFile: submission.entryFile
            };
            
            await triggerGraderWorkflow(repoUrl, jobId, webhookUrl, 'run-visual-evaluation', extraPayload);
          } catch (e) {
            clearTimeout(timeoutId);
            await subscriber.quit();
            return reject(e);
          }
        });

        subscriber.on('message', async (channel, message) => {
          if (channel === `github_webhook_${jobId}`) {
            clearTimeout(timeoutId);
            await subscriber.quit();
            try {
              const payload = JSON.parse(message);
              if (payload.status === 'completed') {
                resolve(payload.result || []);
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
      `visual-eval ${jobId}`
    );

    logger.info(`Job completed via GitHub Actions: ${jobId}`);

    return {
      success: true,
      result
    };
  } catch (err) {
    logger.error(`Job failed: ${jobId}`, {
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

/**
 * Setup event handlers for worker
 */
function setupWorkerEvents() {
  if (!visualWorker) return;

  // Job completed
  visualWorker.on('completed', (job, result) => {
    logger.info(`Visual Job ${job.id} completed`, {
      duration: job.finishedOn - job.processedOn,
      students: result?.results?.length
    });
  });

  // Job failed
  visualWorker.on('failed', (job, err) => {
    logger.error(`Visual Job ${job.id} failed`, {
      error: err.message,
      attempts: job.attemptsMade,
      maxAttempts: job.attempts
    });
  });

  // Job started
  visualWorker.on('active', (job) => {
    logger.info(`Visual Job ${job.id} started processing`);
  });

  // Stalled job (took too long)
  visualWorker.on('stalled', (jobId) => {
    logger.warn(`Visual Job ${jobId} stalled`);
  });

  // Error in worker
  visualWorker.on('error', (err) => {
    logger.error('Visual Worker error:', err);
  });

  // Worker is ready
  visualWorker.on('ready', () => {
    logger.info('Visual Worker is ready');
  });

  // Worker connection closed
  visualWorker.on('closed', () => {
    logger.info('Visual Worker closed');
  });
}

/**
 * Graceful shutdown
 */
export async function stopVisualWorker() {
  try {
    logger.info('Stopping visual worker...');

    if (visualWorker) {
      await visualWorker.close();
    }

    // No longer closing browser pool

    logger.info('Visual worker stopped');

  } catch (err) {
    logger.error('Error stopping visual worker:', err);
  }
}

/**
 * Get worker status
 */
export function getVisualWorkerStatus() {
  if (!visualWorker) {
    return { status: 'not_initialized' };
  }

  return {
    status: 'running',
    isRunning: !visualWorker.closing,
    concurrency: queueManager.getConfig('visual').concurrency
  };
}

export { visualWorker };