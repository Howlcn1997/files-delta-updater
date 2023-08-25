const DeltaUpdater = require("../src/delta-updater.js");

const updater = new DeltaUpdater({
  localRootPath: "C:\\Users\\howlw\\Desktop\\app",
  remoteRootUrl: "http://localhost:8080",
});

// 无可用更新
updater.on("not-available", (...args) => {
  console.log("not-available:", args);
});

// 资源正在下载
updater.on("downloading", (...args) => {
  console.log("downloading:", args);
});

// 资源已下载
updater.on("downloaded", (...args) => {
  console.log("downloaded:", args);
});

// 更新资源可使用
updater.on("usable", (...args) => {
  console.log("usable:", args);
});

updater.checkUpdate();
updater.getCurrentVersionPath().then((address) => console.log("当前版本地址：", address));
