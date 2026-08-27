# EML Manager

轻量级 Windows 桌面邮件查看器，用于浏览、检索和管理本地 `.eml` 邮件文件。纯本地运行，不收发邮件、不上传任何数据。

基于 **Tauri 2 + Rust + 原生 JavaScript/CSS** 构建，安装包体积小、内存占用低、启动迅速。

## 功能特性

### 浏览与阅读
- 三栏布局：侧边栏 / 邮件列表 / 阅读器
- HTML 正文沙箱渲染（禁用脚本），自动将 `cid:` 内嵌图片替换显示
- HTML / 纯文本双视图切换
- 全局明亮 / 暗黑主题，邮件正文深浅色跟随主题（可跟随切换即时刷新）
- 头信息查看：完整原始 RFC 822 头部

### 组织与检索
- 扫描指定文件夹建立邮件库，支持按日期、主题、发件人、体积排序
- 关键字搜索：主题、发件人、收件人、文件名
- **收件 / 发件分类**：设置"我的邮箱"地址后自动归类该邮箱收到和发出的邮件
- **联系人往来视图**：侧栏自动汇总所有联系人，点击即可筛选某联系人的全部往来邮件；阅读器中的发件人/收件人/抄送地址同样可点击
- 含附件筛选

### 管理操作
- 附件另存为单个文件或一键导出全部附件
- 附件使用系统默认程序直接打开
- 邮件文件重命名、移动到其他文件夹、删除（移入系统回收站，可撤销）
- 在资源管理器中定位邮件文件
- 键盘 ↑ / ↓ 快速切换邮件

### 兼容性
- RFC 2047 编码头部解码（B/Q 编码）
- 字符集支持 UTF-8、GBK、GB18030、BIG5 等（基于 encoding_rs）

## 开发

### 环境要求
- Windows 10 及以上
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.dev/)（stable）
  - MSVC 工具链：需安装 Visual Studio Build Tools
  - **GNU 工具链**（`x86_64-pc-windows-gnu`）：需要完整的 MinGW-w64 binutils（`gcc`、`as`、`dlltool`、`windres`），并保证其在 PATH 中

### 常用命令

```powershell
# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 发布打包（NSIS 安装包 + 独立 exe）
npm run tauri build

# 仅构建独立 exe，不打安装包
npm run tauri build -- --no-bundle
```

Windows GNU 工具链用户可直接使用一键脚本（自动前置 MinGW PATH）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\dev.ps1     # 开发
powershell -ExecutionPolicy Bypass -File tools\build.ps1   # 打包
```

## 构建产物

| 文件 | 说明 |
|---|---|
| `src-tauri/target/release/eml-manager.exe` | 绿色单文件版 |
| `src-tauri/target/release/bundle/nsis/*-setup.exe` | NSIS 安装包 |

## 项目结构

```
EMLManager/
├── index.html              # 页面结构
├── src/
│   ├── main.js             # 前端逻辑（列表/阅读器/筛选/联系人/主题）
│   └── ui.css              # 样式（明亮 + 暗黑双主题 CSS 变量）
├── src-tauri/
│   ├── src/main.rs         # Rust 后端（EML 解析、文件管理、系统集成）
│   ├── tauri.conf.json     # Tauri 配置
│   └── capabilities/       # 权限白名单
├── samples/                # 测试样例邮件
└── tools/                  # 一键脚本、图标生成等辅助工具
```

## 后端命令一览

| 命令 | 功能 |
|---|---|
| `parse_eml` | 解析 EML，返回头/正文/附件结构化数据 |
| `read_attachment` | 读取附件字节（内嵌图渲染用） |
| `export_attachment` | 导出附件到指定路径 |
| `open_attachment` | 释放附件至临时目录并用默认程序打开 |
| `scan_library` | 扫描文件夹生成邮件摘要列表 |
| `move_eml_files` / `rename_eml` | 移动 / 重命名 |
| `delete_eml_files` | 删除至回收站 |
| `reveal_in_explorer` | 资源管理器定位文件 |

## 隐私说明

- 所有数据仅保存在本机：应用设置存于 WebView 本地存储，附件临时文件位于系统临时目录
- 应用不包含任何网络请求代码，不收集、不上传任何信息

## License

MIT
