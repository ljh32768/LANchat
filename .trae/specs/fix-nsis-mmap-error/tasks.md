# Tasks

- [ ] Task 1: 清理 NSIS 缓存、release 输出与临时文件
  - [ ] SubTask 1.1: 删除 `release/` 目录
  - [ ] SubTask 1.2: 删除 NSIS 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\`
  - [ ] SubTask 1.3: 删除 `%TEMP%` 下所有 `ns*.tmp` 残留临时文件
  - [ ] SubTask 1.4: 验证三者均已清空（无报错、无残留）

- [ ] Task 2: 配置 Windows Defender 排除项
  - [ ] SubTask 2.1: 以管理员权限运行 PowerShell，执行 `Add-MpPreference -ExclusionPath` 为项目目录 `D:\cpp\programs\AI\LANchatroom` 添加排除
  - [ ] SubTask 2.2: 为 electron-builder 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache` 添加排除
  - [ ] SubTask 2.3: 为 NSIS 缓存目录 `C:\Users\admin\AppData\Local\electron-builder\Cache\nsis-3.0.4.1` 添加排除
  - [ ] SubTask 2.4: 为 Windows 临时目录 `$env:TEMP` 添加排除
  - [ ] SubTask 2.5: 用 `Get-MpPreference` 验证四个排除项均已生效

- [ ] Task 3: 更新 package.json 的 NSIS 配置与脚本
  - [ ] SubTask 3.1: 在 `build.nsis` 中新增 `uninstallDisplayName: "LANChatroom 1.0.0"`
  - [ ] SubTask 3.2: 在 `build.nsis` 中新增 `compression: "maximum"`
  - [ ] SubTask 3.3: 在 `scripts` 中新增 `dist:nsis:clean` 脚本，封装"清理 release + 清理 NSIS 缓存 + 清理 ns*.tmp + 重新打包"流程
  - [ ] SubTask 3.4: 验证 package.json 为合法 JSON（`node -e "require('./package.json')"`）

- [ ] Task 4: 执行清理打包流程并验证
  - [ ] SubTask 4.1: 执行 `npm run dist:nsis:clean`（含 `NODE_TLS_REJECT_UNAUTHORIZED=0` 以绕过 SSL 证书问题）
  - [ ] SubTask 4.2: 确认打包过程无 `error creating mmap` 错误
  - [ ] SubTask 4.3: 确认 `release\LANChatroom Setup 1.0.0.exe` 文件已生成
  - [ ] SubTask 4.4: 若 Task 4.1 仍失败，将 `build.nsis.compression` 改为 `store` 并重试打包作为降级方案

- [ ] Task 5: 验证安装包可正常安装与运行
  - [ ] SubTask 5.1: 运行生成的 `LANChatroom Setup 1.0.0.exe`
  - [ ] SubTask 5.2: 验证安装向导显示中文界面、可选安装目录、可选"为当前用户/所有用户安装"
  - [ ] SubTask 5.3: 完成安装后启动应用，确认窗口正常显示、无白屏崩溃
  - [ ] SubTask 5.4: 验证应用数据写入 `C:\Users\admin\AppData\Roaming\LANChatroom\chat.db`（打包后系统标准 userData 路径）

# Task Dependencies
- [Task 2] 依赖 [Task 1]（先清理再排除，避免 Defender 重新扫描已锁文件）
- [Task 3] 与 [Task 1]、[Task 2] 可并行（仅修改 package.json）
- [Task 4] 依赖 [Task 1]、[Task 2]、[Task 3]（清理 + 排除 + 配置三者就绪后方可打包）
- [Task 5] 依赖 [Task 4]（打包成功后方可验证安装）
