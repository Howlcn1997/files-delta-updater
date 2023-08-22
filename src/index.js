const { EventEmitter } = require("events");
const path = require("path");
const fsx = require("fs-extra");

const { generateFilesJSON, diffFilesJSON } = require("./utils/tools");

const LOCAL_ROOT_PATH = "D:/workspace/files-delta-updater/test/local";
const REMOTE_ROOT_URL = "D:/workspace/files-delta-updater/test/remote";

class DeltaUpdater extends EventEmitter {
  constructor({ localRootPath, remoteRootUrl, currentVersion }) {
    super();
    this.localRootPath = localRootPath;
    this.remoteRootUrl = remoteRootUrl;
    this.currentVersion = currentVersion;
    this.manifestJSON = null;
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
      this.emit("not-available", { reason: "version", message: "" });
      return "not-available--version";
    }
    // 灰度判断
    const stagingPercentage = 100;
    if (stagingPercentage > remoteVersionJSON.stagingPercentage) {
      this.emit("not-available", { reason: "staging" });
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

  async switchToLatestVersion() {}

  async getManifestJSON() {
    if (this.manifestJSON) return this.manifestJSON;
    const manifestJSONPath = path.join(LOCAL_ROOT_PATH, "manifest.json");
    const isExist = await fsx.pathExists(manifestJSONPath);
    if (!isExist) this.manifestJSON = await this.setManifestJSON();
    this.manifestJSON = await fsx.readJSON(manifestJSONPath);
    return this.manifestJSON;
  }

  async setManifestJSON(content = {}) {
    const manifestJSONPath = path.join(LOCAL_ROOT_PATH, "manifest.json");
    const isExist = await fsx.pathExists(manifestJSONPath);
    let jsonContent;

    if (isExist) {
      const oldJsonContent = await fsx.readJSON(manifestJSONPath);
      jsonContent = { ...oldJsonContent, ...content };
    } else {
      const versions = await fsx.readdir(path.join(LOCAL_ROOT_PATH, "versions"));
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

    const downloadRootDir = path.join(localRootPath, "downloaded");
    // 生成本地当前版本的files.json
    const currentFilesJSON = await generateFilesJSON(
      path.join(localRootPath, "versions", currentVersion),
      currentVersion
    );
    // 获取远程下一个版本的files.json
    const nextFilesJSON = await this.requestRemoteFilesJSON(remoteRootUrl, nextVersion);
    // 比较两个版本的files.json，获取差异信息
    const diffFilesJsonData = diffFilesJSON(currentFilesJSON, nextFilesJSON);
    // 下载差异文件
    const downloadedFilepaths = await this.downloadFilesByFilesJSON(diffFilesJsonData, remoteRootUrl, downloadRootDir);
    this.emit("downloaded", { total: diffFilesJsonData.files.length, process: diffFilesJsonData.files.length });

    // 合并本地当前版本的文件和下载的差异文件，生成下一个版本的文件目录列表
    const files = {};
    downloadedFilepaths.forEach(([relativePath, downloadFilename]) => {
      files[relativePath] = downloadFilename;
    });

    currentFilesJSON.files.forEach(([relativePath]) => {
      if (files[relativePath]) return;
      files[relativePath] = path.join(localRootPath, "versions", currentVersion, relativePath);
    });

    await fsx.ensureDir(nextLocalVersionDir);
    await fsx.emptyDir(nextLocalVersionDir);

    // download文件夹版本和本地当前版本文件合并到下一个版本目录
    await Promise.all(
      Object.keys(files).map((relativePath) =>
        fsx.copy(files[relativePath], path.join(nextLocalVersionDir, relativePath))
      )
    );

    // 清理download文件夹
    await fsx.emptyDir(downloadRootDir);
    await this.setManifestJSON({ nextVersion });
    this.emit("usable", { currentVersion, nextVersion, nextLocalVersionDir });
  }

  async requestRemoteFilesJSON(url, version) {
    return require(path.join("D:/workspace/files-delta-updater/test/remote", "files", `${version}.json`));
  }

  async requestRemoteVersionJSON() {
    const defaultVersion = { stagingPercentage: 100 };
    return require(path.join("D:/workspace/files-delta-updater/test/remote", "version.json"));
  }

  async downloadFilesByFilesJSON(filsJSON, remoteRootUrl, downloadRootDir) {
    const downloadVersionDir = path.join(downloadRootDir, filsJSON.version);
    const total = filsJSON.files.length;
    let process = 0;
    const that = this;

    await fsx.ensureDir(downloadVersionDir);
    await fsx.emptyDir(downloadVersionDir);

    return Promise.all(
      filsJSON.files.map(([relativePath]) => {
        const assetUrl = path.join(remoteRootUrl, "versions", filsJSON.version, relativePath);
        const downloadFilepath = path.join(downloadVersionDir, relativePath);

        
        return fsx.copy(assetUrl, downloadFilepath).then(() => {
          that.emit("downloading", { total, process: ++process });
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

  async getCurrentVersionPath() {
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
      // this.clearOldVersions()
      //   .then(() => {})
      //   .catch(() => {});
    }
    return path.join(this.localRootPath, "versions", manifestJSON.version);
  }
}

const updater = new DeltaUpdater({ localRootPath: LOCAL_ROOT_PATH, remoteRootUrl: REMOTE_ROOT_URL });

// 无可用更新
updater.on("not-available", (...args) => {
  console.log("not-available:", args);
});

// 资源正在下载
updater.on("downloading", (...args) => {
  console.log("downloading:", args);
});

// 资源已下载
updater.on("downloaded", (...args) => {
  console.log("downloaded:", args);
});

// 更新资源可使用
updater.on("usable", (...args) => {
  console.log("usable:", args);
});

updater.checkUpdate();
updater.getCurrentVersionPath().then((address) => console.log("当前版本地址：", address));

// generateFilesJSON(path.join(REMOTE_ROOT_URL, "versions", "1.0.0.3"), "1.0.0.3").then((data) => {
//   console.log(JSON.stringify(data));
// });
