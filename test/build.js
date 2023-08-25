const { build } = require("../src/build");
const path = require("path");

const sourceDir = path.join(__dirname, "mock-src");
const destDir = path.join(__dirname, "release");
const version = "1.0.0.0";

build(sourceDir, destDir, version);
