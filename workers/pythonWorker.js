import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { triggerGraderWorkflow } from '../services/githubActionService.js';
import { withTimeout } from '../evaluators/react/utils/timeout.js';
import { webhookPubSub } from '../services/webhookPubSub.js';

let pythonWorker = null;

export async function initializePythonWorker() {
  try {
    logger.info('Initializing python Worker...');

    const jsQueue = queueManager.getQueue('python');
    const config = queueManager.getConfig('python');

    pythonWorker = new Worker(
      'python-evaluation',
      async (job) => {
          try {
            logger.info(`Starting Python evaluation via GitHub Actions: ${job.id}`);
            const { submission, testCases, evaluationMode, entryFunction, expectedLogs } = job.data;
            const repoUrl = submission.repoUrl;
            
            const results = await withTimeout(
              (async () => {
                const webhookPromise = webhookPubSub.waitForWebhook(job.id, config.timeout);
                
                const webhookUrl = `${process.env.BASE_URL}/api/webhook/github`;
                const extraPayload = { testCases, evaluationMode, entryFunction, expectedLogs };
                await triggerGraderWorkflow(repoUrl, job.id, webhookUrl, 'run-python-evaluation', extraPayload);
                
                const githubResult = await webhookPromise;
                
                if (githubResult.status === 'completed') {
                  const testCaseResults = githubResult.results || [];
                  let score = 0;
                  let feedback = "Evaluation completed successfully.";
                  
                  if (evaluationMode === 'function') {
                    const total = testCaseResults.length;
                    const passed = testCaseResults.filter(r => r.passed).length;
                    score = total > 0 ? (passed / total) * 100 : 0;
                    feedback = `Passed ${passed} out of ${total} test cases.`;
                  } else if (evaluationMode === 'script') {
                    score = testCaseResults[0]?.score || 0;
                    feedback = testCaseResults[0]?.passed ? "All logs matched." : "Some logs did not match.";
                  }

                  return {
                    score,
                    feedback,
                    details: testCaseResults
                  };
                } else {
                  throw new Error("GitHub Actions job failed or cancelled");
                }
              })(),
              config.timeout,
              `python-eval ${job.id}`
            );
            
            logger.info(`Python Job ${job.id} completed via GitHub Actions`);
            return { success: true, results };
          } catch (err) {
            logger.error(`Python Job ${job.id} failed`, err);
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