import { EventEmitter } from "events";
import path from "path";
import fsx from "fs-extra";
import download from "download";

import { request } from "./utils/request";
import { createProxy } from "./utils/create-proxy";
import { generateFilesJSON, diffFilesJSON } from "./utils/tools";

import { FilesJSON, UpdaterConfig, VersionJSON } from "./utils/types";

class DeltaUpdater extends EventEmitter {
  localRootPath: string;
  remoteRootUrl: string;
  localConfig: null | UpdaterConfig;
  clearOldVersion: boolean;

  constructor({ localRootPath, remoteRootUrl, clearOldVersion }) {
    super();
    this.localRootPath = localRootPath;
    this.remoteRootUrl = remoteRootUrl;
    this.localConfig = null;
    this.clearOldVersion = clearOldVersion || true;
    return createProxy(this, this.handleError.bind(this));
  }

  async checkUpdate() {
    const [localConfig, remoteVersionJSON] = await Promise.all([this.getConfigJson(), this.requestRemoteVersionJSON()]);

    if (localConfig.nextVersion === remoteVersionJSON.version) {
      this.emit("usable", {
        curVersion: localConfig.curVersion,
        nextVersion: localConfig.nextVersion,
        nextLocalVersionDir: path.join(this.localRootPath, "versions", localConfig.nextVersion),
      });
      return "usable";
    }

    // 版本判断
    if (localConfig.curVersion === remoteVersionJSON.version) {
      this.emit("not-available", { reason: `Already the latest version[${localConfig.curVersion}]` });
      return "not-available--version";
    }
    // 灰度判断
    const stagingPercentage = 100;
    if (stagingPercentage > (remoteVersionJSON.stagingPercentage || 100)) {
      this.emit("not-available", { reason: "Not in grayRelease range" });
      return "not-available--staging";
    }

    await this.buildNextVersion(
      this.localRootPath,
      this.remoteRootUrl,
      localConfig.curVersion,
      remoteVersionJSON.version
    );

    return "success";
  }

  async switchToLatestVersion() {
    const localConfig = await this.getConfigJson();
    if (localConfig.nextVersion) {
      const nextLocalVersionDir = path.join(this.localRootPath, "versions", localConfig.nextVersion);
      const isExist = await fsx.pathExists(nextLocalVersionDir);
      if (!isExist) {
        localConfig.nextVersion = "";
      } else {
        Object.assign(localConfig, {
          curVersion: localConfig.nextVersion,
          nextVersion: "",
        });
      }
      await this.updateConfigJson(localConfig);
      if (this.clearOldVersion) {
        this.clearOldVersions();
      }
      return true;
    }
    return false;
  }

  /**
   * 获取config.json
   */
  async getConfigJson(): Promise<UpdaterConfig> {
    if (this.localConfig) return this.localConfig;
    const configJSONPath = path.join(this.localRootPath, "config.json");
    const isExist = await fsx.pathExists(configJSONPath);
    if (!isExist) this.localConfig = await this.updateConfigJson();
    this.localConfig = await fsx.readJSON(configJSONPath);
    return this.localConfig as UpdaterConfig;
  }

  /**
   * 更新config.json, 如果config.json不存在，则创建
   */
  async updateConfigJson(content: Partial<UpdaterConfig> = {}): Promise<UpdaterConfig> {
    const configJSONPath = path.join(this.localRootPath, "config.json");
    const isExist = await fsx.pathExists(configJSONPath);
    let jsonContent: UpdaterConfig;

    if (isExist) {
      const oldJsonContent = await fsx.readJSON(configJSONPath);
      jsonContent = { ...oldJsonContent, ...content };
    } else {
      const versions = await fsx.readdir(path.join(this.localRootPath, "versions"));
      jsonContent = {
        baseVersion: versions[0],
        curVersion: versions[0],
        nextVersion: "",
        onErrorVersions: [],
        ...content,
      };
    }
    await fsx.writeJSON(configJSONPath, jsonContent);
    this.localConfig = jsonContent;
    return this.localConfig;
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
    await this.updateConfigJson({ nextVersion });
    this.emit("downloaded", { currentVersion, nextVersion, nextLocalVersionDir });
  }

  async requestRemoteFilesJSON(version): Promise<FilesJSON> {
    return request(this.remoteRootUrl + `/files/${version}.json`);
  }

  async requestRemoteVersionJSON(): Promise<VersionJSON> {
    return request(this.remoteRootUrl + "/version.json");
  }

  async downloadFilesByFilesJSON(filsJSON: FilesJSON, downloadRootDir: string): Promise<string[][]> {
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
    const localConfig = await this.getConfigJson();
    const versions = await fsx.readdir(path.join(this.localRootPath, "versions"));
    const oldVersions = versions.filter((version) => version !== localConfig.curVersion);
    await Promise.all(oldVersions.map((version) => fsx.remove(path.join(this.localRootPath, "versions", version))));
  }

  async getLatestVersionThenSwitch(): Promise<string> {
    await this.switchToLatestVersion();
    const localConfig = await this.getConfigJson();
    return path.join(this.localRootPath, "versions", localConfig.curVersion);
  }

  private handleError(error) {
    this.emit("error", error);
  }
}

export default DeltaUpdater;
