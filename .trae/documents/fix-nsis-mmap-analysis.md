# NSIS 打包失败根因分析

## 错误现象

`npm run dist:nsis` 在执行到 NSIS 编译阶段时失败，报错：

```
Internal compiler error #12345: error creating mmap the size of 120307089
```

该错误发生在 `electron-builder` 完成以下步骤之后：
1. ✅ Vite 构建前端资源
2. ✅ 复制文件到 `win-unpacked/`
3. ✅ 生成 7z 载荷 (`lanchatroom-1.0.0-x64.nsis.7z`)
4. ❌ `makensis.exe` 编译 NSIS 脚本时建立 mmap 失败

## 根因分析

### 根因 1：Windows Defender 实时保护锁定文件（主因）

- `makensis.exe` 在编译安装程序时需要读取 7z 载荷文件并建立**内存映射文件（mmap）**
- Windows Defender 的实时扫描会**锁定**被扫描的文件
- 当 Defender 持有文件锁时，`makensis.exe` 无法创建 mmap，导致编译失败
- 这是 Windows 上 NSIS 打包大体积 Electron 应用的**已知常见问题**

**证据：**
- 7z 载荷大小：**103,459,504 字节**（~98.7 MB）
- mmap 错误大小：**120,307,089 字节**（~115 MB，含 NSIS 脚本开销）
- 此前会话中已有 Windows Defender 拦截 `WinShell.dll` 的记录

### 根因 2：7z 载荷体积过大

- 即使使用 `compression: "maximum"`（7z 最高压缩），载荷仍接近 **100 MB**
- 包含：Electron 运行时 + Chromium 引擎 + sql.js (wasm) + React 应用
- 大文件 mmap 更容易受到系统资源竞争和文件锁的影响
- 可降级为 `compression: "store"`（不压缩）来绕过 7z mmap 路径

### 根因 3：NSIS 缓存与临时文件残留

- 之前失败的构建会在 `%TEMP%` 留下 `ns*.tmp` 临时文件
- `C:\Users\admin\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\` 中可能有损坏的缓存
- 残留文件会干扰新的构建，导致 mmap 地址冲突

### 根因 4：NSIS 脚本包含 26 种语言

从 `builder-debug.yml` 可以看到 NSIS 生成的脚本会加载 26 种语言模块：

```
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "SimpChinese"
...（共 26 种）
```

虽然这不直接影响 mmap 错误，但**增加了 NSIS 编译器的内存占用和临时文件数量**，间接加剧了 mmap 失败的概率。

### 已排除的原因：中文字符编码

- 之前怀疑 `productName` 中文乱码导致 NSIS 编译失败
- 当前配置已全部改为 ASCII：`productName: "LANChatroom"`、`shortcutName: "LANChatroom"`、`uninstallDisplayName: "LANChatroom 1.0.0"`
- 但改为 ASCII 后错误依然存在，确认**不是编码问题**

## 当前配置状态

| 配置项 | 当前值 | 状态 |
|--------|--------|------|
| `productName` | `LANChatroom` (ASCII) | ✅ 正确 |
| `shortcutName` | `LANChatroom` (ASCII) | ✅ 正确 |
| `uninstallDisplayName` | `LANChatroom 1.0.0` (ASCII) | ✅ 正确 |
| `compression` | `maximum` | ✅ 已配置 |
| `dist:nsis:clean` 脚本 | 已存在（清理缓存 + 重新打包） | ✅ 已配置 |

## 修复方案

### 方案 A：添加 Windows Defender 排除项（推荐）

以管理员身份运行 PowerShell，执行：

```powershell
Add-MpPreference -ExclusionPath "D:\cpp\programs\AI\LANchatroom"
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\electron-builder\Cache"
Add-MpPreference -ExclusionPath "$env:TEMP"
```

然后执行 `npm run dist:nsis:clean` 清理缓存后重新打包。

**优点：** 根治 Defender 锁定问题，不影响压缩率
**缺点：** 需要管理员权限，仅限当前机器

### 方案 B：降级压缩为 store（降级方案）

将 `package.json` 中的 `compression` 从 `"maximum"` 改为 `"store"`：

```json
"compression": "store"
```

这会绕过 7z mmap 路径，但安装包体积会增大到 ~250 MB。

**优点：** 不需要管理员权限，任何机器都能打包
**缺点：** 安装包体积显著增大

### 方案 C：组合方案

先执行方案 A，如果仍失败则执行方案 B。

## 验证步骤

1. 执行 `npm run dist:nsis:clean`（清理 release/ + NSIS 缓存 + 临时文件）
2. 确认无 `error creating mmap` 错误
3. 确认 `release\LANChatroom Setup 1.0.0.exe` 已生成
4. 运行安装包验证中文向导正常
5. 安装后启动应用，确认无白屏