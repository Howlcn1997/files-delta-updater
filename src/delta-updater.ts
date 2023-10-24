import { EventEmitter } from "events";
import path from "path";
import fsx from "fs-extra";
import download from "download";
import axios, { AxiosInstance } from "axios";
import { requestInstanceCreate } from "./utils/request";

import { createProxy } from "./utils/create-proxy";
import { generateFilesJSON, diffFilesJSON } from "./utils/tools";

import { BuildConfigJson, DeltaUpdaterConfig, FilesJSON, UpdaterConfig, VersionJSON } from "./utils/types";
import { stringHash } from "./utils/hash";

class DeltaUpdater extends EventEmitter {
  baseRootPath: string;
  updateRootPath: string;
  remoteRootUrl: string;
  clearOldVersion: boolean;
  channels: string[];

  private hashKey: string;
  private curRootPath: string;
  private curConfig: null | UpdaterConfig;
  private requestInstance: AxiosInstance;

  constructor({
    baseRootPath,
    updateRootPath,
    remoteRootUrl,
    hashKey = "",
    channels = [],
    clearOldVersion = true,
    requestInstanceCreator = requestInstanceCreate,
  }: DeltaUpdaterConfig) {
    super();
    this.baseRootPath = baseRootPath;
    this.updateRootPath = updateRootPath;
    this.channels = channels;
    this.remoteRootUrl = `${remoteRootUrl}/${this.channels.join("/")}/`;
    this.hashKey = hashKey;
    this.clearOldVersion = clearOldVersion;
    this.curConfig = null;
    this.requestInstance = requestInstanceCreator(axios);
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

  private async getCurRootPath(): Promise<string> {
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

  /**
   * @returns "match" channel 符合预期
   *          "reset" channel 不符合预期，重置更新状态和更新文件
   *          "skip"  channel 不符合预期，无需重置更新状态，无法清理更新文件
   */
  private async checkChannelMatchAndReset(): Promise<"match" | "not-match"> {
    const curRootPath = await this.getCurRootPath(); // curRootPath 为 baseRootPath 或 updateRootPath
    const curConfig = await this.getConfigJson();

    if (curConfig.channels.join("/") === this.channels.join("/")) return "match";

    console.warn(`channels has changed, old: ${curConfig.channels.join("/")}, new: ${this.channels.join("/")}`);

    if (curRootPath === this.baseRootPath) return "not-match";

    // 异步清理旧版本文件
    console.info("Cleaning up old update files");
    await fsx.remove(curRootPath).then(() => console.log("Cleaning of old update files is completed"));

    // 更新工作目录重置为baseRootPath
    this.curRootPath = this.baseRootPath;
    // 以新工作目录更新configJson
    this.curConfig = null;
    const curConfigAfterReset = await this.getConfigJson();

    if (curConfigAfterReset.channels.join("/") === this.channels.join("/")) return "match";

    return "not-match";
  }

  private async switchToLatestVersion(): Promise<{
    version: string;
    path: string;
  }> {
    const curConfig = await this.getConfigJson();
    const curRootPath = await this.getCurRootPath();
    if (curConfig.nextVersion) {
      const nextVersionDir = path.join(curRootPath, "versions", curConfig.nextVersion);
      const isExist = await fsx.pathExists(nextVersionDir);
      if (isExist) {
        curConfig.curVersion = curConfig.nextVersion;
      }
      curConfig.nextVersion = "";

      await this.updateConfigJson(curConfig);
      this.clearOldVersions();
    }
    return {
      version: curConfig.curVersion,
      path: path.join(curRootPath, "versions", curConfig.curVersion),
    };
  }

  /**
   * 获取config.json
   */
  private async getConfigJson(): Promise<UpdaterConfig> {
    if (this.curConfig) return this.curConfig;
    const curRootPath = await this.getCurRootPath();
    const configJSONPath = path.join(curRootPath, "config.json");

    const isExist = await fsx.pathExists(configJSONPath);

    if (isExist) {
      this.curConfig = await fsx.readJSON(configJSONPath);
    } else {
      const versions = await fsx.readdir(path.join(this.baseRootPath, "versions"));
      this.curConfig = {
        baseVersion: versions[0],
        curVersion: versions[0],
        nextVersion: "",
        channels: this.channels,
        onErrorVersions: [],
      };
    }
    // as UpdaterConfig
    return this.curConfig;
  }

  /**
   * 更新config.json, 如果config.json不存在，则创建
   */
  private async updateConfigJson(content: Partial<UpdaterConfig> = {}): Promise<UpdaterConfig> {
    const curRootPath = await this.getCurRootPath();
    const curConfigJSONPath = path.join(curRootPath, "config.json");

    this.curConfig = {
      ...(await this.getConfigJson()),
      ...content,
    };
    await fsx.writeJSON(curConfigJSONPath, this.curConfig);
    return this.curConfig;
  }

  private async buildNextVersion(currentVersion, nextVersion) {
    const buildTargetRootPath = this.updateRootPath;

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
        channels: this.channels,
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

  private requestRemoteFilesJSON(version): Promise<FilesJSON> {
    return this.requestInstance(this.remoteRootUrl + `files/${version}.json`);
  }

  private requestRemoteVersionJSON(): Promise<VersionJSON> {
    return this.requestInstance(this.remoteRootUrl + "version.json");
  }

  private async downloadFilesByFilesJSON(filsJSON: FilesJSON, downloadRootDir: string): Promise<string[][]> {
    const downloadVersionDir = path.join(downloadRootDir, filsJSON.version);
    const total = filsJSON.files.length;
    let process = 0;
    const that = this;

    await fsx.ensureDir(downloadVersionDir);
    await fsx.emptyDir(downloadVersionDir);

    return Promise.all(
      filsJSON.files.map(([relativePath]) => {
        const assetUrl = `${this.remoteRootUrl}versions/${filsJSON.version}/${relativePath}`;
        const downloadFilepath = path.join(downloadVersionDir, relativePath);

        return download(assetUrl, path.dirname(downloadFilepath)).then(() => {
          that.emit("download", { total, process: ++process });
          return [relativePath, downloadFilepath];
        });
      })
    );
  }

  async getStagingPercentage(version): Promise<number> {
    const stagingConfPath = path.join(this.updateRootPath, "staging.conf");
    if (await fsx.pathExists(stagingConfPath)) {
      const { staging, key } = await fsx.readJSON(stagingConfPath);
      if (key === stringHash(`${staging}-${version}-${this.hashKey}`)) {
        return parseFloat(staging);
      }
    }
    const staging = Math.random() * 100;
    const conf = {
      staging,
      key: stringHash(`${staging}-${version}-${this.hashKey}`),
    };
    await fsx.ensureDir(this.updateRootPath);
    await fsx.writeJSON(stagingConfPath, conf);
    return staging;
  }

  private handleError(error) {
    this.emit("error", error);
  }

  /**
   * 清理更新目录中的旧版本
   */
  async clearOldVersions() {
    if (!this.clearOldVersion) return;

    const curConfig = await this.getConfigJson();
    const versions = await fsx.readdir(path.join(this.updateRootPath, "versions"));
    const oldVersions = versions.filter((version) => version !== curConfig.curVersion);
    await Promise.all(oldVersions.map((version) => fsx.remove(path.join(this.updateRootPath, "versions", version))));
  }

  async checkUpdate(forceCheck = true) {
    // 渠道判断
    const channelResult = await this.checkChannelMatchAndReset();
    if (channelResult === "not-match") {
      if (!forceCheck) {
        this.emit("not-available", {
          reason: "not-available--channels",
          message: `Channels don’t match, so skip checkUpdate`,
        });
        return "not-available--channels";
      } else {
        console.log(`Channels don’t match, but forceCheck is true, so continue checkUpdate`);
      }
    }

    let [curConfig, remoteVersionJSON] = await Promise.all([this.getConfigJson(), this.requestRemoteVersionJSON()]);

    if (curConfig.nextVersion === remoteVersionJSON.version) {
      const _remoteJson = { ...remoteVersionJSON };
      delete _remoteJson.version;
      delete _remoteJson.stagingPercentage;
      this.emit("usable", {
        curVersion: curConfig.curVersion,
        nextVersion: curConfig.nextVersion,
        nextVersionDir: path.join(await this.getCurRootPath(), "versions", curConfig.nextVersion),
        ..._remoteJson,
      });
      return "usable";
    }

    // 版本判断
    if (curConfig.curVersion === remoteVersionJSON.version) {
      this.emit("not-available", {
        reason: "not-available--version",
        message: `Already the latest version[${curConfig.curVersion}]`,
      });
      return "not-available--version";
    }
    // 灰度判断
    const stagingPercentage = await this.getStagingPercentage(remoteVersionJSON.version);
    if (
      stagingPercentage >
      (remoteVersionJSON.stagingPercentage === undefined ? 100 : remoteVersionJSON.stagingPercentage)
    ) {
      this.emit("not-available", {
        reason: "not-available--staging",
        message: "Not in grayRelease range",
      });
      return "not-available--staging";
    }

    await this.buildNextVersion(curConfig.curVersion, remoteVersionJSON.version);
    return "success";
  }

  // 获取最新版本地址,
  async getLatestVersionAfterSwitch(): Promise<{
    version: string;
    path: string;
  }> {
    const configJSON = await this.getConfigJson();
    if (configJSON.channels.join("/") === this.channels.join("/")) {
      return await this.switchToLatestVersion();
    }
    const baseConfig = await fsx.readJSON(path.join(this.baseRootPath, "config.json"));
    return {
      version: baseConfig.baseVersion,
      path: path.join(this.baseRootPath, "versions", baseConfig.baseVersion),
    };
  }
}

export default DeltaUpdater;
