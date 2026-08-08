// src/evaluators/python/services/executionService.js

import { exec } from "child_process";

export function runPython(filePath, input) {

  return new Promise((resolve) => {

    const process = exec(
      `python "${filePath}"`,
      {
        timeout: 2000
      }
    );

    let output = "";

    process.stdin.write(String(input));

    process.stdin.end();

    process.stdout.on("data", (data) => {
      output += data;
    });

    process.on("close", () => {
      resolve(output.trim());
    });
  });
}