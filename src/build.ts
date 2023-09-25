import fsx from "fs-extra";
import path from "path";
import { generateFilesJSON } from "./utils/tools";
import { BuildReleaseOptions, UpdaterConfig } from "./utils/types";

// 构建需要发布到文件服务器的资源
export async function buildRelease({
  source,
  dist,
  version,
  channels = [],
  stagingPercentage = 100,
  emptyDist = true,
}: BuildReleaseOptions) {
  if (emptyDist) {
    await fsx.emptyDir(dist);
  }
  const destDir = path.join(dist, ...channels);

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
export async function buildLocal({ source, dist, version, emptyDist = true }) {
  if (emptyDist) {
    await fsx.emptyDir(dist);
  }
  const versionsDir = path.join(dist, "versions");

  await fsx.emptyDir(versionsDir);

  await fsx.copy(source, path.join(dist, "versions", version));
  const content: UpdaterConfig = {
    baseVersion: version,
    curVersion: version,
    nextVersion: "",
    onErrorVersions: [],
  };
  await fsx.writeJSON(path.join(dist, "config.json"), content);
}
