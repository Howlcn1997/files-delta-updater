const { EventEmitter } = require("events");
const path = require("path");
const fsx = require("fs-extra");
const download = require("download");

const { request } = require("./utils/request");
const { createProxy } = require("./utils/create-proxy");
const { generateFilesJSON, diffFilesJSON } = require("./utils/tools");

class DeltaUpdater extends EventEmitter {
  constructor({ localRootPath, remoteRootUrl, currentVersion, clearOldVersion }) {
    super();
    this.localRootPath = localRootPath;
    this.remoteRootUrl = remoteRootUrl;
    this.currentVersion = currentVersion;
    this.manifestJSON = null;
    this.clearOldVersion = clearOldVersion || true;
    return createProxy(this, this.handleError.bind(this));
  }

  async checkUpdate() {
    const [localManifest, remoteVersionJSON] = await Promise.all([
      (async () => {
        let manifest = await this.getManifestJSON();
        if (!manifest) manifest = await this.setManifestJSON();
        return manifest;
      })(),
      this.requestRemoteVersionJSON(),
    ]);

    if (localManifest.nextVersion === remoteVersionJSON.version) {
      this.emit("usable", {
        currentVersion: localManifest.version,
        nextVersion: localManifest.nextVersion,
        nextLocalVersionDir: path.join(this.localRootPath, "versions", localManifest.nextVersion),
      });
      return "usable";
    }

    // 版本判断
    if (localManifest.version === remoteVersionJSON.version) {
      this.emit("not-available", { reason: "Already the latest version" });
      return "not-available--version";
    }
    // 灰度判断
    const stagingPercentage = 100;
    if (stagingPercentage > remoteVersionJSON.stagingPercentage) {
      this.emit("not-available", { reason: "Not in grayRelease range" });
      return "not-available--staging";
    }

    await this.buildNextVersion(
      this.localRootPath,
      this.remoteRootUrl,
      localManifest.version,
      remoteVersionJSON.version
    );

    return "success";
  }

  async switchToLatestVersion() {
    const manifestJSON = await this.getManifestJSON();
    if (manifestJSON.nextVersion) {
      const nextLocalVersionDir = path.join(this.localRootPath, "versions", manifestJSON.nextVersion);
      const isExist = await fsx.pathExists(nextLocalVersionDir);
      if (!isExist) {
        manifestJSON.nextVersion = "";
      } else {
        Object.assign(manifestJSON, {
          version: manifestJSON.nextVersion,
          oldVersion: manifestJSON.version,
          nextVersion: "",
        });
      }
      await this.setManifestJSON(manifestJSON);
      if (this.clearOldVersion) {
        this.clearOldVersions();
      }
      return true;
    }
    return false;
  }

  async getManifestJSON() {
    if (this.manifestJSON) return this.manifestJSON;
    const manifestJSONPath = path.join(this.localRootPath, "manifest.json");
    const isExist = await fsx.pathExists(manifestJSONPath);
    if (!isExist) this.manifestJSON = await this.setManifestJSON();
    this.manifestJSON = await fsx.readJSON(manifestJSONPath);
    return this.manifestJSON;
  }

  async setManifestJSON(content = {}) {
    const manifestJSONPath = path.join(this.localRootPath, "manifest.json");
    const isExist = await fsx.pathExists(manifestJSONPath);
    let jsonContent;

    if (isExist) {
      const oldJsonContent = await fsx.readJSON(manifestJSONPath);
      jsonContent = { ...oldJsonContent, ...content };
    } else {
      const versions = await fsx.readdir(path.join(this.localRootPath, "versions"));
      jsonContent = {
        version: versions[0],
        oldVersion: "",
        nextVersion: "",
        ...content,
      };
    }
    await fsx.writeJSON(manifestJSONPath, jsonContent);
    this.manifestJSON = jsonContent;
    return this.manifestJSON;
  }

  async buildNextVersion(localRootPath, remoteRootUrl, currentVersion, nextVersion) {
    const nextLocalVersionDir = path.join(localRootPath, "versions", nextVersion);
    const currentVersionDir = path.join(localRootPath, "versions", currentVersion);

    const downloadRootDir = path.join(localRootPath, "downloaded");
    // 生成本地当前版本的files.json
    const currentFilesJSON = await generateFilesJSON(currentVersionDir, currentVersion);
    // 获取远程下一个版本的files.json
    const nextFilesJSON = await this.requestRemoteFilesJSON(nextVersion);
    // 比较两个版本的files.json，获取差异信息
    const diffFilesJsonData = diffFilesJSON(currentFilesJSON, nextFilesJSON);
    // 下载差异文件
    const downloadedFilepaths = await this.downloadFilesByFilesJSON(diffFilesJsonData, downloadRootDir);

    // 合并本地当前版本的文件和下载的差异文件，生成下一个版本的文件目录列表
    const files = {};

    const downloadFilesMap = {};
    downloadedFilepaths.forEach(([relativePath, downloadFilename]) => {
      downloadFilesMap[relativePath] = downloadFilename;
    });

    const currentFilesMap = {};
    currentFilesJSON.files.forEach(([relativePath]) => {
      currentFilesMap[relativePath] = path.join(currentVersionDir, relativePath);
    });

    const nextVersionFiles = {};
    nextFilesJSON.files.forEach(([relativePath]) => {
      if (downloadFilesMap[relativePath]) {
        nextVersionFiles[relativePath] = downloadFilesMap[relativePath];
        return;
      }
      if (currentFilesMap[relativePath]) {
        nextVersionFiles[relativePath] = currentFilesMap[relativePath];
        return;
      }
    });

    await fsx.ensureDir(nextLocalVersionDir);
    await fsx.emptyDir(nextLocalVersionDir);

    // download文件夹版本和本地当前版本文件合并到下一个版本目录
    await Promise.all(
      Object.keys(nextVersionFiles).map((relativePath) =>
        fsx.copy(nextVersionFiles[relativePath], path.join(nextLocalVersionDir, relativePath))
      )
    );

    // 清理download文件夹
    await fsx.remove(downloadRootDir);
    await this.setManifestJSON({ nextVersion });
    this.emit("downloaded", { currentVersion, nextVersion, nextLocalVersionDir });
  }

  async requestRemoteFilesJSON(version) {
    return request(this.remoteRootUrl + `/files/${version}.json`);
  }

  async requestRemoteVersionJSON() {
    return request(this.remoteRootUrl + "/version.json");
  }

  async downloadFilesByFilesJSON(filsJSON, downloadRootDir) {
    const downloadVersionDir = path.join(downloadRootDir, filsJSON.version);
    const total = filsJSON.files.length;
    let process = 0;
    const that = this;

    await fsx.ensureDir(downloadVersionDir);
    await fsx.emptyDir(downloadVersionDir);

    return Promise.all(
      filsJSON.files.map(([relativePath]) => {
        const assetUrl = `${this.remoteRootUrl}/versions/${filsJSON.version}/${relativePath}`;
        const downloadFilepath = path.join(downloadVersionDir, relativePath);

        return download(assetUrl, path.dirname(downloadFilepath)).then(() => {
          that.emit("download", { total, process: ++process });
          return [relativePath, downloadFilepath];
        });
      })
    );
  }

  async clearOldVersions() {
    const manifestJSON = await this.getManifestJSON();
    const versions = await fsx.readdir(path.join(this.localRootPath, "versions"));
    const oldVersions = versions.filter((version) => version !== manifestJSON.version);
    await Promise.all(oldVersions.map((version) => fsx.remove(path.join(this.localRootPath, "versions", version))));
  }

  async getLatestVersionThenSwitch() {
    await this.switchToLatestVersion();
    const manifestJSON = await this.getManifestJSON();
    return path.join(this.localRootPath, "versions", manifestJSON.version);
  }

  handleError(error) {
    this.emit("error", error);
  }
}

module.exports = DeltaUpdater;
