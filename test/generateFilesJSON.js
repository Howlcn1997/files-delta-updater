const path = require("path");
const { generateFilesJSON } = require("../src/utils/tools");

const version = "1.0.0.3";
const versionDir = path.join(__dirname, `mock-oss/versions/${version}`);

generateFilesJSON(versionDir, version).then((res) => console.log(JSON.stringify(res)));
