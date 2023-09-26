import { EventEmitter } from "events";
import path from "path";
import fsx from "fs-extra";
import download from "download";

import { request } from "./utils/request";
import { createProxy } from "./utils/create-proxy";
import { generateFilesJSON, diffFilesJSON } from "./utils/tools";

import { BuildConfigJson, DeltaUpdaterConfig, FilesJSON, UpdaterConfig, VersionJSON } from "./utils/types";

class DeltaUpdater extends EventEmitter {
  baseRootPath: string;
  updateRootPath: string;
  remoteRootUrl: string;
  clearOldVersion: boolean;
  channels: string[];

  private curRootPath: string;
  private routerConfig: null | UpdaterConfig;

  constructor({ baseRootPath, updateRootPath, remoteRootUrl, clearOldVersion, channels }: DeltaUpdaterConfig) {
    super();
    this.baseRootPath = baseRootPath;
    this.updateRootPath = updateRootPath;
    this.remoteRootUrl = `${remoteRootUrl}/${channels.join("/")}/`;
    this.clearOldVersion = clearOldVersion === undefined ? true : clearOldVersion;
    this.channels = channels || [];
    this.routerConfig = null;
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

  public async buildConfigJson(rootPath, jsonContent: BuildConfigJson): Promise<string> {
    const configJSON = {
      baseVersion: jsonContent.baseVersion,
      curVersion: jsonContent.curVersion,
      nextVersion: "",
      onErrorVersions: [],
      ...jsonContent,
    };
    await fsx.ensureDir(rootPath);
    const configPath = path.join(rootPath, "config.json");
    await fsx.writeJSON(configPath, configJSON);

    return configPath;
  }

  async getCurRootPath(): Promise<string> {
    if (this.curRootPath) return this.curRootPath;

    const updateConfigExist = await fsx.pathExists(path.join(this.updateRootPath, "config.json"));
    if (updateConfigExist) {
      this.curRootPath = this.updateRootPath;
      return this.updateRootPath;
    }

    const baseConfigExist = await fsx.pathExists(path.join(this.baseRootPath, "config.json"));
    if (baseConfigExist) {
      this.curRootPath = this.baseRootPath;
      return this.baseRootPath;
    }

    return this.baseRootPath;
    // throw new Error("No base config.json exists");
  }

  async checkChannelMatchAndReset() {
    let config = await this.getConfigJson();

    if (config.channels.join("/") === this.channels.join("/")) return "match";

    console.warn(`channels has changed, old: ${config.channels.join("/")}, new: ${this.channels.join("/")}`);
    // baseRootPath是热更新的基础依赖，不能清理
    // 若当前目录是baseRootPath，则跳过清理
    if (this.baseRootPath === this.updateRootPath || (await this.getCurRootPath()) === this.baseRootPath) {
      return "skip";
    }

    console.info("clean old update files and update status");
    await fsx.remove(this.updateRootPath);
    this.routerConfig = null;
    this.curRootPath = undefined;
    await this.getCurRootPath();
    await this.getConfigJson();
    return "reset";
  }

  async checkUpdate() {
    let [routerConfig, remoteVersionJSON] = await Promise.all([this.getConfigJson(), this.requestRemoteVersionJSON()]);

    const action = await this.checkChannelMatchAndReset();
    if (action === "skip") {
      console.log("cannot clear baseRootPath dir, so skip checkUpdate");
      return "skip";
    }

    if (routerConfig.nextVersion === remoteVersionJSON.version) {
      this.emit("usable", {
        curVersion: routerConfig.curVersion,
        nextVersion: routerConfig.nextVersion,
        nextVersionDir: path.join(await this.getCurRootPath(), "versions", routerConfig.nextVersion),
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

  async switchToLatestVersion(): Promise<string> {
    const routerConfig = await this.getConfigJson();
    const curRootPath = await this.getCurRootPath();
    if (routerConfig.nextVersion) {
      const nextVersionDir = path.join(curRootPath, "versions", routerConfig.nextVersion);
      const isExist = await fsx.pathExists(nextVersionDir);
      if (isExist) {
        routerConfig.curVersion = routerConfig.nextVersion;
      }
      routerConfig.nextVersion = "";

      await this.updateConfigJson(routerConfig);
      if (this.clearOldVersion) {
        this.clearOldVersions();
      }
    }
    return path.join(curRootPath, "versions", routerConfig.curVersion);
  }

  /**
   * 获取config.json
   */
  async getConfigJson(): Promise<UpdaterConfig> {
    if (this.routerConfig) return this.routerConfig;
    const curRootPath = await this.getCurRootPath();
    const configJSONPath = path.join(curRootPath, "config.json");

    const isExist = await fsx.pathExists(configJSONPath);

    if (isExist) {
      this.routerConfig = await await fsx.readJSON(configJSONPath);
    } else {
      const versions = await fsx.readdir(path.join(this.baseRootPath, "versions"));
      this.routerConfig = {
        baseVersion: versions[0],
        curVersion: versions[0],
        nextVersion: "",
        channels: this.channels,
        onErrorVersions: [],
      };
    }
    // as UpdaterConfig
    return this.routerConfig;
  }

  /**
   * 更新config.json, 如果config.json不存在，则创建
   */
  async updateConfigJson(content: Partial<UpdaterConfig> = {}): Promise<UpdaterConfig> {
    const curRootPath = await this.getCurRootPath();
    const curConfigJSONPath = path.join(curRootPath, "config.json");

    this.routerConfig = {
      ...(await this.getConfigJson()),
      ...content,
    };
    await fsx.writeJSON(curConfigJSONPath, this.routerConfig);
    return this.routerConfig;
  }

  async buildNextVersion(currentVersion, nextVersion) {
    let buildTargetRootPath: string;

    if (this.updateRootPath === this.baseRootPath) {
      buildTargetRootPath = this.baseRootPath;
    } else {
      buildTargetRootPath = this.updateRootPath;
    }

    const currentVersionDir = path.join(buildTargetRootPath, "versions", currentVersion);

    const nextVersionDir = path.join(buildTargetRootPath, "versions", nextVersion);

    const downloadRootDir = path.join(buildTargetRootPath, "downloaded");

    // 初始化buildTargetRootPath versions文件夹
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

    await fsx.ensureDir(nextVersionDir);
    await fsx.emptyDir(nextVersionDir);

    // download文件夹版本和本地当前版本文件合并到下一个版本目录
    await Promise.all(
      Object.keys(nextVersionFiles).map((relativePath) =>
        fsx.copy(nextVersionFiles[relativePath], path.join(nextVersionDir, relativePath))
      )
    );

    // 清理download文件夹
    await fsx.remove(downloadRootDir);
    // 更新config.json
    const buildTargetConfigJsonPath = path.join(buildTargetRootPath, "config.json");
    if (await fsx.pathExists(buildTargetConfigJsonPath)) {
      await fsx.writeJSON(buildTargetConfigJsonPath, {
        ...(await fsx.readJSON(buildTargetConfigJsonPath)),
        nextVersion,
      });
    } else {
      await this.buildConfigJson(buildTargetRootPath, {
        ...(await this.getConfigJson()),
        nextVersion,
        channels: this.channels,
      });
    }
    this.emit("downloaded", { currentVersion, nextVersion, nextVersionDir });
  }

  requestRemoteFilesJSON(version): Promise<FilesJSON> {
    return request(this.remoteRootUrl + `files/${version}.json`);
  }

  requestRemoteVersionJSON(): Promise<VersionJSON> {
    return request(this.remoteRootUrl + "version.json");
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
    const action = await this.checkChannelMatchAndReset();
    if (action === "match") {
      return await this.switchToLatestVersion();
    }
    const configJSON = await this.getConfigJson();
    return path.join(this.baseRootPath, "versions", configJSON.baseVersion);
  }

  private handleError(error) {
    this.emit("error", error);
  }
}

export default DeltaUpdater;
