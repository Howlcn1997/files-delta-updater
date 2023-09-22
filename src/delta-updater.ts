import { EventEmitter } from "events";
import path from "path";
import fsx from "fs-extra";
import download from "download";

import { request } from "./utils/request";
import { createProxy } from "./utils/create-proxy";
import { generateFilesJSON, diffFilesJSON } from "./utils/tools";

import { FilesJSON, UpdaterConfig, VersionJSON, Workspace } from "./utils/types";

class DeltaUpdater extends EventEmitter {
  baseRootPath: string;
  updateRootPath: string;
  remoteRootUrl: string;
  routerConfig: null | UpdaterConfig;
  clearOldVersion: boolean;
  channel: string[];

  constructor({ baseRootPath, updateRootPath, remoteRootUrl, clearOldVersion = true, channel = [] }) {
    super();
    this.baseRootPath = baseRootPath;
    this.updateRootPath = updateRootPath;
    this.remoteRootUrl = remoteRootUrl;
    this.routerConfig = null;
    this.clearOldVersion = clearOldVersion;
    this.channel = channel;
    return createProxy(this, this.handleError.bind(this));
  }

  public async getValidLatestVersion(rootPath) {
    // 检查config.json
    const configExist = await fsx.pathExists(path.join(rootPath, "config.json"));
    if (!configExist) return false;

    // 检查versions
    const versionsExist = await fsx.pathExists(rootPath, "versions");
    if (versionsExist) return false;

    const versions = await fsx.readdir(path.join(rootPath, "versions"));
    if (versions.length < 0) return false;

    // 比较config.json
    const configJSON = await fsx.readJSON(path.join(rootPath, "config.json"));
    if (versions.includes(configJSON.nextVersion) && configJSON.nextVersion) return configJSON.nextVersion;

    if (versions.includes(configJSON.curVersion) && configJSON.curVersion) return configJSON.curVersion;
  }

  async getWorkspace(): Promise<string> {
    const routerConfig = await this.getConfigJson();
    return routerConfig.workspace === "update" ? this.updateRootPath : this.baseRootPath;
  }

  async checkUpdate() {
    const [routerConfig, remoteVersionJSON] = await Promise.all([
      this.getConfigJson(),
      this.requestRemoteVersionJSON(),
    ]);

    if (routerConfig.nextVersion === remoteVersionJSON.version) {
      this.emit("usable", {
        curVersion: routerConfig.curVersion,
        nextVersion: routerConfig.nextVersion,
        nextVersionDir: path.join(await this.getWorkspace(), "versions", routerConfig.nextVersion),
      });
      return "usable";
    }

    // 版本判断
    if (routerConfig.curVersion === remoteVersionJSON.version) {
      this.emit("not-available", { reason: `Already the latest version[${routerConfig.curVersion}]` });
      return "not-available--version";
    }
    // 灰度判断
    const stagingPercentage = 100;
    if (stagingPercentage > (remoteVersionJSON.stagingPercentage || 100)) {
      this.emit("not-available", { reason: "Not in grayRelease range" });
      return "not-available--staging";
    }

    await this.buildNextVersion(routerConfig.curVersion, remoteVersionJSON.version);

    return "success";
  }

  async switchToLatestVersion() {
    const routerConfig = await this.getConfigJson();
    if (routerConfig.nextVersion) {
      const nextVersionDir = path.join(await this.getWorkspace(), "versions", routerConfig.nextVersion);
      const isExist = await fsx.pathExists(nextVersionDir);
      if (!isExist) {
        routerConfig.nextVersion = "";
      } else {
        Object.assign(routerConfig, {
          curVersion: routerConfig.nextVersion,
          nextVersion: "",
        });
      }
      await this.updateConfigJson(routerConfig);
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
    if (this.routerConfig) return this.routerConfig;
    const configJSONPath = path.join(this.updateRootPath, "config.json");
    const isExist = await fsx.pathExists(configJSONPath);
    this.routerConfig = isExist ? await fsx.readJSON(configJSONPath) : await this.updateConfigJson();
    return this.routerConfig as UpdaterConfig;
  }

  /**
   * 更新config.json, 如果config.json不存在，则创建
   */
  async updateConfigJson(content: Partial<UpdaterConfig> = {}): Promise<UpdaterConfig> {
    const configJSONPath = path.join(this.updateRootPath, "config.json");

    const localVersionsPath = path.join(this.updateRootPath, "versions");

    const isExist = await fsx.pathExists(configJSONPath);
    let jsonContent: UpdaterConfig;

    if (isExist) {
      const oldJsonContent = await fsx.readJSON(configJSONPath);
      jsonContent = { ...oldJsonContent, ...content };
    } else {
      await fsx.ensureDir(this.updateRootPath);

      const localVersionExits = await fsx.pathExists(localVersionsPath);

      let versions = localVersionExits ? await fsx.readdir(localVersionsPath) : [];
      let workspace: Workspace = "update";

      if (!versions.length) {
        versions = await fsx.readdir(path.join(this.baseRootPath, "versions"));
        workspace = "base";
      }

      if (!versions.length) throw new Error("No version exists");

      jsonContent = {
        baseVersion: versions[0],
        curVersion: versions[0],
        nextVersion: "",
        onErrorVersions: [],
        workspace,
        ...content,
      };
    }
    await fsx.writeJSON(configJSONPath, jsonContent);
    this.routerConfig = jsonContent;
    return this.routerConfig;
  }

  async buildNextVersion(currentVersion, nextVersion) {
    const nextLocalVersionDir = path.join(this.updateRootPath, "versions", nextVersion);
    const currentVersionDir = path.join(this.updateRootPath, "versions", currentVersion);

    const downloadRootDir = path.join(this.updateRootPath, "downloaded");

    // 初始化updateRootPath versions文件夹
    const versionsExist = await fsx.pathExists(currentVersionDir);
    if (!versionsExist) {
      await fsx.emptyDir(path.join(currentVersionDir, ".."));
      await fsx.symlink(path.join(this.baseRootPath, "versions", currentVersion), currentVersionDir, "junction");
    }
    // 生成本地当前版本的files.json
    const currentFilesJSON = await generateFilesJSON(currentVersionDir, currentVersion);
    // 获取远程下一个版本的files.json
    const nextFilesJSON = await this.requestRemoteFilesJSON(nextVersion);
    // 比较两个版本的files.json，获取差异信息
    const diffFilesJsonData = diffFilesJSON(currentFilesJSON, nextFilesJSON);
    // 下载差异文件
    const downloadedFilepaths = await this.downloadFilesByFilesJSON(diffFilesJsonData, downloadRootDir);

    const downloadFilesMap = {};
    downloadedFilepaths.forEach(([relativePath, downloadFilename]) => {
      downloadFilesMap[relativePath] = downloadFilename;
    });

    const currentFilesMap = {};
    currentFilesJSON.files.forEach(([relativePath]) => {
      currentFilesMap[relativePath] = path.join(currentVersionDir, relativePath);
    });

    // 合并本地当前版本的文件和下载的差异文件，生成下一个版本的文件目录列表
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
    await this.updateConfigJson({ nextVersion, workspace: "update" });
    this.emit("downloaded", { currentVersion, nextVersion, nextLocalVersionDir });
  }

  async requestRemoteFilesJSON(version): Promise<FilesJSON> {
    return request(this.remoteRootUrl + "/" + this.channel.map((i) => `${i}/`) + `files/${version}.json`);
  }

  async requestRemoteVersionJSON(): Promise<VersionJSON> {
    return request(this.remoteRootUrl + "/" + this.channel.map((i) => `${i}/`) + "version.json");
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

  /**
   * 清理更新目录中的旧版本
   */
  async clearOldVersions() {
    const routerConfig = await this.getConfigJson();
    const versions = await fsx.readdir(path.join(this.updateRootPath, "versions"));
    const oldVersions = versions.filter((version) => version !== routerConfig.curVersion);
    await Promise.all(oldVersions.map((version) => fsx.remove(path.join(this.updateRootPath, "versions", version))));
  }

  // 获取最新版本地址, 
  async getLatestVersionAfterSwitch(): Promise<string> {
    await this.switchToLatestVersion();
    const routerConfig = await this.getConfigJson();
    console.log(routerConfig);
    return path.join(await this.getWorkspace(), "versions", routerConfig.curVersion);
  }

  private handleError(error) {
    this.emit("error", error);
  }
}

export default DeltaUpdater;
