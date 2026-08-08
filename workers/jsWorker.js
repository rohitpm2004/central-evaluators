import { Worker } from 'bullmq';
import redisConnection from '../config/redis.js';
import queueManager from '../config/queueManager.js';
import logger from '../config/logger.js';
import { cloneRepo, deleteRepo } from '../evaluators/js/repoService.js';
import { findJavaScriptFile } from '../evaluators/js/fileService.js';
import { evaluateStudent } from '../evaluators/js/evaluationService.js';

let jsWorker = null;

export async function initializeJsWorker() {
  try {
    logger.info('Initializing JavaScript Worker...');

    const config = queueManager.getConfig('javascript');

    jsWorker = new Worker(
      'javascript-evaluation',
      async (job) => {
        let repoPath;
        try {
          logger.info(`Starting JS evaluation: ${job.id}`);

          const {
            submission,
            testCases,
            entryFunction,
            evaluationMode,
            expectedLogs,
            functions
          } = job.data;

          repoPath = await cloneRepo(submission.repoUrl);

          // Tell findJavaScriptFile which function name(s) we're about to
          // grade so it can pick the .js file that actually defines them,
          // instead of just the first one alphabetically (see fileService.js).
          const mode = evaluationMode || 'function';
          const requiredNames = mode === 'multi-function'
            ? (functions || []).map(fn => fn && fn.name).filter(Boolean)
            : (entryFunction ? [entryFunction] : []);

          const filePath = findJavaScriptFile(repoPath, requiredNames);

          // Author: Arma Sahar
          // Bug (jsBugs.md #9): this early-return used to have a different
          // response shape ({ success, results: [...] }) than the normal
          // path below ({ success, studentId, studentName, evaluation }),
          // making the job result inconsistent for API consumers. Fixed to
          // return the same flat shape either way.
          if (!filePath) {
            return {
              success: true,
              studentId: submission.studentId,
              studentName: submission.studentName,
              evaluation: {
                score: 0,
                error: 'No JavaScript file found'
              }
            };
          }

          logger.info(`[JS WORKER] Processing ${submission.studentName}`);
          logger.info(`[JS WORKER] Found file: ${filePath}`);
          logger.info(`[JS WORKER] Entry Function: ${entryFunction}`);

          const evaluation = await evaluateStudent({
            filePath,
            evaluationMode: evaluationMode || 'function',
            entryFunction,
            testCases,
            expectedLogs,
            functions
          });

          logger.info(`JS Job ${job.id} completed`);

          // Author: Arma Sahar
          // Bug (jsBugs.md #8): every logger.info call below this line used
          // to sit after an earlier `return`, so it was unreachable dead
          // code and never actually logged anything. Moved the logging
          // above the return so it runs, and dropped the unused `results`
          // array the dead code referenced.
          return {
            success: true,
            studentId: submission.studentId,
            studentName: submission.studentName,
            evaluation
          };
        } catch (err) {
          logger.error(`JS Job ${job.id} failed`, err);
          throw err;
        } finally {
          if (repoPath) {
            await deleteRepo(repoPath);
            logger.info(`[JS WORKER] Deleted temp repo: ${repoPath}`);
          }
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
    jsWorker.on('completed', (job, result) => {
      logger.info(`JS Job ${job.id} completed`, {
        duration: job.finishedOn - job.processedOn
      });
    });

    jsWorker.on('failed', (job, err) => {
      logger.error(`JS Job ${job.id} failed`, {
        error: err.message,
        attempts: job.attemptsMade
      });
    });

    logger.info('JavaScript Worker initialized');
    return jsWorker;

  } catch (err) {
    logger.error('Failed to initialize JS worker:', err);
    throw err;
  }
}

export async function stopJsWorker() {
  try {
    if (jsWorker) {
      await jsWorker.close();
    }
    logger.info('JS worker stopped');
  } catch (err) {
    logger.error('Error stopping JS worker:', err);
  }
}

export function getJsWorkerStatus() {
  return {
    status: jsWorker ? 'running' : 'not_initialized',
    concurrency: queueManager.getConfig('javascript').concurrency
  };
}

export { jsWorker };
