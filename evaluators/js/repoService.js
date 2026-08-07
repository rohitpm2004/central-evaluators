import path from 'path';
import fs from 'fs';
import { simpleGit } from 'simple-git';
import { assertSafeUrl, getAllowedGitHosts } from '../visual/utils/urlGuard.js';
import { parseGithubTreeUrl } from '../backend/extractService.js';

const TEMP_DIR = path.join(process.cwd(), 'temp');

// Author: Arma Sahar
// Bug (jsBugs.md #5): this used to build a shell string with
// `execSync(\`git clone ${repoUrl} ${repoPath}\`)`. Since execSync runs the
// command through `/bin/sh -c`, an unescaped repoUrl like
// "https://x/y.git; rm -rf ~" is executed as two separate shell commands —
// confirmed with a PoC (`; touch <marker>` actually created the file).
// Fixed by (1) validating the URL is http(s), not private/loopback, and on
// an allowed git host via assertSafeUrl (same guard the visual evaluator
// uses), and (2) cloning with simple-git, which passes the URL as a single
// argv entry to `git` — never through a shell — so it can't be reinterpreted
// as extra commands.
export async function cloneRepo(repoUrl) {

  if (!repoUrl) {
    throw new Error('repoUrl is required');
  }

  // Handle GitHub blob/tree URLs by extracting the base repo URL
  const parsedGithub = parseGithubTreeUrl(repoUrl);
  const actualCloneUrl = parsedGithub ? parsedGithub.cloneUrl : repoUrl;

  await assertSafeUrl(actualCloneUrl, { allowedHosts: getAllowedGitHosts() });

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const repoName = `repo_${Date.now()}`;
  const repoPath = path.join(TEMP_DIR, repoName);

  // --depth 1: shallow clone, we only ever need the latest snapshot.
  // `--`: ends option parsing so a hostile URL can't smuggle git flags.
  const cloneArgs = ['--depth', '1'];
  if (parsedGithub && parsedGithub.branch) {
    cloneArgs.push('--branch', parsedGithub.branch);
  }
  cloneArgs.push('--');

  await simpleGit().clone(actualCloneUrl, repoPath, cloneArgs);

  return repoPath;
}

export async function deleteRepo(repoPath) {
  try {
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, {
        recursive: true,
        force: true
      });
    }
  } catch (err) {
    console.error(
      `[REPO CLEANUP ERROR] ${err.message}`
    );
  }
}