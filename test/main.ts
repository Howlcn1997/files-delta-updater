import DeltaUpdater from "../src/delta-updater";
import path from "path";
import liveServer from "live-server";

const baseRootPath = path.join(__dirname, "mock-app");
// const updateRootPath = path.join(__dirname, "mock-app");
const updateRootPath = path.join(__dirname, "mock-upd");
const mockOSSDir = path.join(__dirname, "mock-oss");
const remoteRootUrl = "http://localhost:8080";

liveServer.start({ port: 8080, root: mockOSSDir, open: false });

const os = process.argv.slice(2)[0] || "x86";

const updater = new DeltaUpdater({
  baseRootPath,
  updateRootPath,
  remoteRootUrl,
  clearOldVersion: true,
  channels: [os, "beta"],
});

// 无可用更新
updater.on("not-available", (...args) => {
  console.log("not-available:", args[0]);
});

// 资源正在下载
updater.on("download", (...args) => {
  console.log("download:", args[0]);
});

updater.on("downloaded", (...args) => {
  console.log("downloaded:", args[0]);
});

// 更新资源可使用
updater.on("usable", (...args) => {
  console.log("usable:", args[0]);
});

updater.on("error", (...args) => {
  console.log("error:", args[0]);
});

updater.getLatestVersionAfterSwitch().then((address) => console.log("当前版本地址：", address));
updater.checkUpdate();
