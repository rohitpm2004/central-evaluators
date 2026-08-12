// src/evaluators/python/services/fileService.js

import fs from "fs";
import path from "path";

export function findPythonFiles(rootDir) {

  const students = [];

  // Check root directory for .py files
  const rootFiles = fs.readdirSync(rootDir);
  const rootPyFiles = rootFiles.filter(f => fs.lstatSync(path.join(rootDir, f)).isFile() && f.endsWith(".py"));
  if (rootPyFiles.length > 0) {
    students.push({
      name: "root",
      filePath: path.join(rootDir, rootPyFiles[0])
    });
  }

  // Also check subfolders
  for (const item of rootFiles) {
    const itemPath = path.join(rootDir, item);
    if (!fs.lstatSync(itemPath).isDirectory() || item === '.git') {
      continue;
    }

    const files = fs.readdirSync(itemPath);
    const pyFiles = files.filter(file => file.endsWith(".py"));

    if (pyFiles.length > 0) {
      students.push({
        name: item,
        filePath: path.join(itemPath, pyFiles[0])
      });
    }
  }

  return students;
}