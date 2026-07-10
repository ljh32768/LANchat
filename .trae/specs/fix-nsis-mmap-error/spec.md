# 修复 NSIS 打包 mmap 错误 Spec

## Why
`npm run dist:nsis` 在 NSIS 编译阶段持续失败，报错 `Internal compiler error #12345: error creating mmap the size of 120307187`。此前怀疑是中文 productName/shortcutName/description 乱码所致，但已将三者全部改为 ASCII 后错误依旧，说明根因与字符编码无关。错误中 mmap 的尺寸（~115MB）与 `lanchatroom-1.0.0-x64.nsis.7z` 载荷大小一致，且 NSIS 提示存在 stale temporary file，结合此前会话中 Windows Defender 拦截 `WinShell.dll` 的记录，判定为 Defender 实时保护锁定 7z 载荷文件 + NSIS 缓存/临时文件残留，导致 `makensis.exe` 无法建立内存映射。

## What Changes
- 清理 NSIS 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\` 并强制重新下载
- 清理 Windows 临时目录中残留的 `ns*.tmp` 临时文件
- 为 Windows Defender 添加实时保护排除项：
  - 项目目录 `D:\cpp\programs\AI\LANchatroom`
  - electron-builder 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache`
  - NSIS 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache\nsis-3.0.4.1`
  - Windows 临时目录 `%TEMP%`
- 在 `package.json` 的 `build` 字段新增 `nsis.uninstallDisplayName`（保持 ASCII，避免回退到默认中文乱码），并补充 `compression` 显式配置以便后续可选切换
- 新增 `npm run dist:nsis:clean` 脚本，封装"清理缓存 + 重新打包"流程，便于复现
- 验证打包成功后安装包可正常安装与运行

## Impact
- Affected specs: 无（本项为打包工具链修复，不触及运行时功能）
- Affected code:
  - `package.json`（新增脚本与 NSIS 字段）
  - 系统层：Windows Defender 排除项（PowerShell `Add-MpPreference`，需管理员权限一次性配置）
  - 文件系统：清理 `release/`、NSIS 缓存、临时目录

## ADDED Requirements

### Requirement: 清理 NSIS 缓存与临时文件
系统 SHALL 在打包前提供一键清理脚本，移除 NSIS 缓存目录、`release/` 输出目录及临时目录中的 `ns*.tmp` 残留文件，确保 `makensis.exe` 不会读取到损坏或被锁定的缓存。

#### Scenario: 缓存清理成功
- **WHEN** 执行 `npm run dist:nsis:clean`
- **THEN** 删除 `release/` 目录、NSIS 缓存目录、`%TEMP%\ns*.tmp` 临时文件
- **AND** 重新执行 `electron-builder --win nsis`
- **AND** 打包过程不再出现 `error creating mmap` 错误

### Requirement: Windows Defender 排除项
系统 SHALL 通过 PowerShell 脚本为 Windows Defender 添加项目目录与缓存目录的实时保护排除项，避免 Defender 在 NSIS 写入/读取 7z 载荷时锁定文件导致 mmap 失败。

#### Scenario: 添加排除项
- **GIVEN** 用户以管理员权限运行 PowerShell
- **WHEN** 执行 `Add-MpPreference -ExclusionPath` 针对项目目录、electron-builder 缓存、NSIS 缓存、临时目录
- **THEN** Defender 实时保护不再扫描上述路径
- **AND** 后续 `npm run dist:nsis` 可正常完成

### Requirement: 显式压缩配置
`package.json` 的 `build.nsis` SHALL 显式设置 `compression` 字段，默认使用 `maximum`（7z），并在打包失败时支持快速切换为 `store`（不压缩）以绕过 7z mmap 路径作为降级方案。

#### Scenario: 默认压缩
- **WHEN** 执行 `npm run dist:nsis`
- **THEN** NSIS 使用 7z maximum 压缩
- **AND** 安装包体积最小

#### Scenario: 降级压缩
- **WHEN** 7z mmap 错误复现且 Defender 排除项无效
- **THEN** 用户可将 `compression` 改为 `store`
- **AND** 打包成功（安装包体积变大但可正常安装）

## MODIFIED Requirements

### Requirement: NSIS 安装包配置
`package.json` 的 `build.nsis` 配置 SHALL 满足：
- `oneClick: false`（非一键安装，提供安装向导）
- `perMachine: false`（默认为当前用户安装，不强制管理员）
- `allowToChangeInstallationDirectory: true`（允许用户选择安装目录）
- `allowElevation: true`（允许在"为所有用户安装"时提权）
- `language: "2052"`（简体中文界面）
- `shortcutName: "LANChatroom"`（ASCII，避免 NSIS 命令行乱码）
- `uninstallDisplayName: "LANChatroom 1.0.0"`（ASCII，控制面板卸载项显示名）
- `compression: "maximum"`（显式声明压缩级别）

## REMOVED Requirements
无
