# 文章同步（Article Relay）

将微信公众号文章导入本地，再一键同步为知乎草稿的桌面工具。适合需要分发原创或已获转载授权文章的创作者和运营人员。

**粘贴公众号链接 → 下载正文和原图 → 同步到知乎草稿 → 在知乎复核并发布**

## 功能

- **一次导入，重复使用。** 正文和原图保存到本机。同一篇文章再次同步时复用本地素材，下载中断后只补缺失的图片。
- **同步到知乎草稿。** 在应用内登录知乎，上传本地图片并写入草稿。草稿可以在应用内打开，也可以复制编辑链接。公开发布由用户在知乎完成。
- **查看任务和记录。** 左侧列出文章任务，右侧显示下载进度、每次同步的结果、失败原因和草稿链接。重启后可以继续处理已有任务。

## 开始使用

1. 粘贴公众号文章链接，点击「导入公众号文章」。遇到微信验证时，在右侧完成验证，再点击「继续读取文章」。
2. 点击「打开知乎」，在应用内登录。随后在左侧选择已导入的文章，点击「同步到知乎草稿」。
3. 在「平台同步记录」中点击「打开草稿」，核对标题、正文和图片，再在知乎发布。

再次导入同一链接会打开已有任务。原文有更新时，选中任务并点击「重新导入原文」。同步失败时可以直接重试。旧草稿已删除且知乎返回 `404` 时，应用会新建草稿，并在本次记录中给出新链接。

## 运行和打包

### macOS 本地开发和测试

使用 **Node.js 24 或更高版本**和 npm。克隆仓库后，在项目根目录依次执行以下两条命令。

```sh
npm ci
npm start
```

运行 `npm test` 可检查 TypeScript 编译，并验证图片下载续传、任务记录和草稿处理逻辑。项目使用 Electron、TypeScript 和原生 HTML/CSS/JavaScript。

在本机执行 `npm run build:mac`，会生成适用于当前 Node.js 架构的测试应用。Intel 版本在 `release/mac/文章同步.app`，Apple 芯片版本在 `release/mac-arm64/文章同步.app`。本地测试使用临时签名，无需 Apple 开发者证书。

### Windows x64 安装包

仓库提供 [GitHub Actions 打包工作流](.github/workflows/windows.yml)。有仓库写入权限的维护者可以在默认分支配置好工作流后，打开 **Actions → 构建 Windows 安装包 → Run workflow**。构建成功后下载 `ArticleRelay-Windows-x64`，解压后运行 `.exe` 安装程序。

最终使用者直接安装应用即可。Electron 运行时与 Chromium 随安装包提供，无需另装 Node.js 或 Chrome。

### 通过 GitHub 构建和发布 macOS 安装包

[macOS 工作流](.github/workflows/macos.yml) 分别构建 Apple 芯片（`arm64`）和 Intel（`x64`）的 `.dmg`。

- **内测构建**使用 **Actions → 构建 macOS 安装包 → Run workflow**。完成后在 **Artifacts** 下载对应架构的安装包。内测包使用临时签名，适合开发验证。
- **公开发布**使用与 `package.json` 版本一致的 Git 标签，例如 `v0.1.0`。推送标签后，工作流签名并公证两个架构的应用，再创建包含两个安装包的 GitHub Release 草稿。核对后，在 **Releases** 页面发布草稿。

发布前，在仓库的 **Settings → Secrets and variables → Actions** 设置以下 Repository secrets。

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | 包含私钥的 Developer ID Application `.p12` 证书，使用 Base64 编码 |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 导出密码。证书未设置密码时可留空。 |
| `APPLE_API_KEY_CONTENT` | Apple 公证用 App Store Connect API 私钥文件 `.p8` 的完整文本 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |

## 当前支持范围

| 项目 | 支持范围 |
| --- | --- |
| 导入来源 | 微信公众号图文链接，支持正文图片和图文轮播图片 |
| 同步目标 | 知乎文章草稿 |
| 正文格式 | 基础文本、标题、列表、引用、链接、代码块、表格和图片。特殊卡片、音视频及公众号自定义样式需在草稿中另行处理。 |

文章素材、浏览器登录会话和同步记录存放在应用的本地数据目录。应用使用知乎网页的草稿接口，平台改版后可能需要更新适配。
