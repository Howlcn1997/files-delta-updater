import fsx from "fs-extra";
import path from "path";
import { generateFilesJSON } from "./utils/tools";

export async function build(sourceDir, destDir, version, stagingPercentage = 100) {
  await fsx.emptyDir(destDir);

  const filesDir = path.join(destDir, "files");
  await fsx.emptyDir(filesDir);
  const filesJson = await generateFilesJSON(sourceDir, version);
  await fsx.writeJSON(path.join(filesDir, `${version}.json`), filesJson);

  const versionsDir = path.join(destDir, "versions", version);
  await fsx.emptyDir(versionsDir);
  await fsx.copy(sourceDir, versionsDir);

  // 生成version.json
  await fsx.writeJSON(path.join(destDir, `version.json`), { version, stagingPercentage });
}
