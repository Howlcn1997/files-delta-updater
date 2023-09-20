import { build } from "../src/build";
import path from "path";

const sourceDir = path.join(__dirname, "mock-src");
const destDir = path.join(__dirname, "release");
const version = "1.0.0.1";

build(sourceDir, destDir, version);