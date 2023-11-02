
# files-delta-updater

你可以使用`files-detla-updater`在仅仅使用静态资源服务器的条件下来实现资源的差量更新

## 安装

You need node.js and npm.

```
npm install files-delta-updater --save-dev
```

## 使用

```
const { DeltaUpdater } = require('files-delta-updater');

const deltaUpdater = new DeltaUpdater({
	baseRootPath: "C:\\Program Files\\myapp\\dist",
	updateRootPath: "C:\\Program Files\\myapp_source\\dist",
	remoteRootUrl: "https://oss.template.com/myapp", 
	channels: ["1.0.0","stable"]
})

deltaUpdater.getLatestVersionAfterSwitch().then(({path, version}) => {
	console.log(path); // The directory where the latest version of the file is located
	console.log(version); // the latest version

	deltaUpdater.checkUpdate(); // Start checking for updates
})
```


### `new DeltaUpdater(options)`
- `options` DeltaUpdaterConfig
	- `baseRootPath` string (必填) - 更新器基础目录。当无已下载的更新资源时，则更新器使用该目录进行工作。
	- `updateRootPath` string (必填) - 更新器版本管理目录。新生成的目录将保存在此目录下。
	- `remoteRootUrl` string (必填) - 远程资源的URL。
	- `channels` string[] (可选) - 更新渠道。分渠道更新资源。
	- `clearOldVersion` boolean (可选) - 是否清理老版本资源。默认值为`true`，当更新器切换至最新版本后，将自动清理老版本资源文件。
	- `versionAvailable` function (可选) - 自定版本比较规则。默认 当本地版本与远程版本不一致时进行更新。
	- `requestInstanceCreator` function (可选) - 自定义在获取更新文件时使用的axios实例

#### 实例方法

##### 方法：`getLatestVersionAfterSwitch()`

返回： `Promise<{ version: string; path: string; }>`

- `version` 本地可用的最新版本
- `path` 本地可用的最新版本所在目录

##### 方法：`checkUpdate(forceCheck)`

参数：`forceCheck`<br>
默认值`true`，检查步骤中的渠道检查不通过时则继续更新流程，否则反之。

返回： 
- `checkResult` 枚举值
	- `not-available--channels`
	- `not-available--version`
	- `not-available--staging`
	- `usable`
	- `success`


#### 实例事件

使用`new DeltaUpdater`创建的对象具有以下事件：

##### 事件：`not-available`

无可用更新时触发；<br>
返回：
- `result`
	- `reason` 
	- `message`

- `reason`值的枚举：
	- `not-available--channels` 渠道检查不满足条件
	- `not-available--version` 版本检查不满足条件
	- `not-available--staging` 灰度更新检查不满足条件

##### 事件：`download`

资源正在下载时触发；<br>
返回：
- `result`
	- `total` 
	- `process`

 - `total` 带下载资源总数
 - `process` 下载进度

##### 事件：`downloaded`

资源下载完成时触发；<br>
返回：
- `result`
	- `currentVersion` 
	- `nextVersion`
	- `nextVersionDir`

 - `currentVersion` 当前版本号
 - `nextVersion` 下一个版本号
 - `nextVersionDir` 下一个版本所在目录
##### 事件：`usable`

可用资源已下载至本地且已生成最新版本资源文件时触发；<br>
返回：
- `result`
	- `currentVersion` 
	- `nextVersion`
	- `nextVersionDir`

 - `currentVersion` 当前版本号
 - `nextVersion` 下一个版本号
 - `nextVersionDir` 下一个版本所在目录

##### 事件：`error`

更新器运行报错时触发；<br>
返回：
- `Error`



