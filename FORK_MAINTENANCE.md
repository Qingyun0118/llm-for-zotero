# Qingyun 维护版

本仓库基于 Yile Wang 的 LLM for Zotero，保留原项目许可证与署名。
维护版增加文献会话标题同步，以及字符图、代码块、SVG 和图片同步修复。
配套浏览器扩展：<https://github.com/Qingyun0118/sync-for-zotero>。

## 安装与更新

首次从本仓库版本 Release 下载 `llm-for-zotero.xpi`，在 Zotero 插件管理器
选择“从文件安装”，按提示重启。插件 ID 保持不变，因此会替换当前安装。
后续自动更新读取本仓库固定 `release` 标签中的 `update.json`。
不要删除该标签或其更新清单。

浏览器扩展使用配套仓库的 `extension/` 固定目录加载，更新后在浏览器扩展
管理页重新加载，并刷新 ChatGPT 页面。旧消息需要重新加载网页会话才能
应用提取修复。远程图片仍取决于原地址的可访问性；网页交互不会迁入 Zotero。

## 手动合并上游

`origin` 为 Qingyun0118 仓库；`upstream` 为 yilewang 仓库。工作区必须干净。

```sh
git fetch upstream
git switch -c merge-upstream
git merge upstream/main
```

解决冲突时保留本仓库发布地址、插件 ID、配置前缀、标题同步和渲染修复。
版本号必须大于已发布的维护版与此次合并的上游版本，同步更新锁文件。
更新 `RELEASE_NOTES.md`，然后验证：

```sh
npm ci
npm run lint:check
npm test
npm run build
npm run verify:release
```

npm 12 若阻止锁定的 Git 类型依赖，安装命令加 `--allow-git=all`。
通过检查后将合并分支合入 main，再推送到 origin，创建与 package.json
版本一致的 `v版本号` 标签并推送到 origin。标签发布流程先运行质量检查，
再上传 XPI 并更新固定清单。禁止向 upstream 推送。

发布后下载 XPI 与更新清单，验证版本、插件 ID、地址及 SHA-512 一致。

本仓库也支持将版本文件或 `RELEASE_NOTES.md` 的变更推送到 main 后发布：
工作流通过检查后创建当前版本 Release。每次发布都必须递增版本；已存在
相同版本 Release 时流程会停止，避免覆盖已发布安装包。标签发布入口仍保留。

隔离工作流测试需设置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 指向 Zotero 可执行文件。
无桌面环境可加 `MOZ_HEADLESS=1`。CI 使用官方 Zotero 10.0.6 与独立测试配置。
