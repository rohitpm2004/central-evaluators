import { cloneRepo, deleteRepo } from "./repoService.js";
import runTests from "./playwrightService.js";
import scoreSubmission from "./scoringService.js";

export async function evaluateReactProject(
  payload
) {
  let repoPath;
  try {
    repoPath =
      await cloneRepo(payload.repoUrl);

    const testResults =
      await runTests(repoPath);

    return await scoreSubmission(
      testResults,
      payload.rubric,
      repoPath
    );
  } finally {
    if (repoPath) {
      await deleteRepo(repoPath);
    }
  }
}