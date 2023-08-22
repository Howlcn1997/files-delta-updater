const path = require("path");
const fsx = require("fs-extra");

/**
 * @param {String} root 根目录
 * @param {String} version 版本号
 *
 * @return {Object} files.json
 */
async function generateFilesJSON(root, version) {
  const filepaths = await fsBFS(root);
  const hashResults = await Promise.all(filepaths.map((filepath) => calculateFileMD5(path.join(root, filepath))));

  const filesWithHash = filepaths.map((filepath, index) => [
    path.posix.join(...filepath.split(/\\/)),
    hashResults[index],
  ]);
  
  return {
    version,
    timestamp: Date.now(),
    files: filesWithHash,
  };
}

/**
 * 比较file.json文件获取差异文件
 * 若有冲突文件，则以jsonB为准
 *
 * @return {Object} files.json
 */
function diffFilesJSON(jsonA, jsonB) {
  const jsonAMap = {};
  jsonA.files.forEach(([relativePath, hash]) => (jsonAMap[relativePath] = hash));
  const diffFiles = jsonB.files.filter(([relativePath, hash]) => {
    if (!jsonAMap[relativePath]) return true;
    if (jsonAMap[relativePath] !== hash) return true;
    return false;
  });
  return {
    ...jsonB,
    type: "diff",
    files: diffFiles,
  };
}

/**
 * 广度优先遍历文件目录
 * @return {Array<string>} 返回文件路径数组 不包含空文件夹
 */
async function fsBFS(rootPath, withFn) {
  const result = [];
  const queue = [""];
  while (queue.length) {
    const currentPath = queue.shift();
    const currentRelativePath = path.join(rootPath, currentPath);

    const isDirectory = (await fsx.stat(currentRelativePath)).isDirectory();
    if (!isDirectory) {
      result.push(withFn ? withFn(currentPath) : currentPath);
      continue;
    }

    let childrenDirs = (await fsx.readdir(currentRelativePath)).map((filename) => path.join(currentPath, filename));
    queue.push(...childrenDirs);
  }
  return result;
}

/**
 * 获取文件md5 hash值
 * @param {String} filePath
 * @returns {String} MD5 Hash
 */
function calculateFileMD5(filePath) {
  const fs = require("fs");
  const crypto = require("crypto");
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const input = fs.createReadStream(filePath);
    input.on("error", (err) => reject(err));
    hash.on("readable", () => {
      const data = hash.read();
      if (data) {
        resolve(data.toString("hex"));
      }
    });
    input.pipe(hash);
  });
}

module.exports = { generateFilesJSON, diffFilesJSON };
