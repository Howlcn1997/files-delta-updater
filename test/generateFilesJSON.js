const { generateFilesJSON } = require("../../src/utils/tools");
const path = require("path");

generateFilesJSON(path.join(__dirname, "../local/versions/1.0.0.1"), "1.0.0.1").then(console.log);
