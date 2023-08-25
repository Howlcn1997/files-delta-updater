const DeltaUpdater = require("../src/delta-updater.js");
const path = require("path");
const liveServer = require("live-server");

const localRootPath = path.join(__dirname, "mock-app");
const mockOSSDir = path.join(__dirname, "mock-oss");
const remoteRootUrl = "http://localhost:8080";
const version = "1.0.0.0";

liveServer.start({ port: 8080, root: mockOSSDir });

const updater = new DeltaUpdater({ localRootPath, remoteRootUrl, open: false });

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

updater.checkUpdate();
updater.getLatestVersionThenSwitch().then((address) => console.log("当前版本地址：", address));
