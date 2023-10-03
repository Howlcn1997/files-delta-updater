export interface FilesJSON {
  version: string;
  timestamp: number;
  files: string[][];
}
export interface DiffFilesJSON extends FilesJSON {
  type: "diff";
}

export interface VersionJSON {
  version: string;
  stagingPercentage?: number;
}

export interface UpdaterConfig {
  baseVersion: string; // 安装包初始版本
  curVersion: string; // 安装包当前版本
  channels: string[]; // 渠道
  nextVersion: string; // 安装包下一个版本
  onErrorVersions: string[]; // 历史错误版本
}

export interface BuildConfigJson {
  baseVersion: string; // 安装包初始版本
  curVersion: string; // 安装包当前版本
  channels: string[]; // 渠道
  nextVersion?: string; // 安装包下一个版本
  onErrorVersions?: string[]; // 历史错误版本
}

export interface DeltaUpdaterConfig {
  baseRootPath: string;
  updateRootPath: string;
  remoteRootUrl: string;
  hashKey?: string;
  clearOldVersion?: boolean;
  channels?: string[];
}

export interface BuildReleaseOptions {
  source: string;
  dist: string;
  version: string;
  channels?: string[];
  stagingPercentage?: number;
  emptyDist?: boolean;
}
