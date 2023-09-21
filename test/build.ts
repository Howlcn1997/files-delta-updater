import { buildRelease, buildLocal } from "../src/build";
import path from "path";

const source = path.join(__dirname, "mock-src");
const version = "1.0.0.1";

(async () => {
  await buildRelease({
    source,
    version,
    dest: path.join(__dirname, "release"),
    stagingPercentage: 80,
    channels: ["x86", "beta"],
  });
  await buildLocal({
    source,
    version,
    dest: path.join(__dirname, "local"),
  });
})();
