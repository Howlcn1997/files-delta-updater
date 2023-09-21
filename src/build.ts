import fsx from "fs-extra";
import path from "path";
import { generateFilesJSON } from "./utils/tools";
import { BuildReleaseOptions, UpdaterConfig } from "./utils/types";

// 构建需要发布到文件服务器的资源
export async function buildRelease({
  source,
  dest,
  version,
  channels = [],
  stagingPercentage = 100,
}: BuildReleaseOptions) {
  await fsx.emptyDir(dest);
  const destDir = path.join(dest, ...channels);

  const filesDir = path.join(destDir, "files");
  await fsx.emptyDir(filesDir);
  const filesJson = await generateFilesJSON(source, version);
  await fsx.writeJSON(path.join(filesDir, `${version}.json`), filesJson);

  const versionsDir = path.join(destDir, "versions", version);
  await fsx.emptyDir(versionsDir);
  await fsx.copy(source, versionsDir);

  // 生成version.json
  await fsx.writeJSON(path.join(destDir, `version.json`), { version, stagingPercentage });
}

// 构建本地资源
export async function buildLocal({ source, dest, version }) {
  await fsx.emptyDir(dest);
  const versionsDir = path.join(dest, "versions");

  await fsx.emptyDir(versionsDir);

  await fsx.copy(source, path.join(dest, "versions", version));
  const content: UpdaterConfig = {
    baseVersion: version,
    curVersion: version,
    nextVersion: "",
    onErrorVersions: [],
  };
  await fsx.writeJSON(path.join(dest, "config.json"), content);
}
