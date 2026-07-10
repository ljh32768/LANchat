// 渲染层专用常量（ESM）。
// 主进程用 shared/constants.js（CJS），渲染层用本文件避免 Vite CJS interop 问题。
export const SESSION_STATUS = {
  ACTIVE: 'active',
  ENDED: 'ended'
};
