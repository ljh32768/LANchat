// 文件 store：上传 / 下载进度与状态
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useFilesStore = create(
  subscribeWithSelector((set, get) => ({
    progress: {},    // file_id -> 0..1
    status: {},      // file_id -> 'pending'|'downloading'|'completed'|'failed'
    storagePath: {}, // file_id -> path

    upload: async (sessionId, filePath) => {
      const res = await window.api.invoke('file:upload', { session_id: sessionId, file_path: filePath });
      // 阶段4：上传失败时抛出错误，让调用方 catch 能处理（主进程返回 { ok: false, error }）
      if (res && res.ok === false) {
        throw new Error(res.error || '上传失败');
      }
      return res;
    },

    download: async (fileId, hostIp, hostPort) => {
      set((state) => ({
        status: { ...state.status, [fileId]: 'downloading' },
        progress: { ...state.progress, [fileId]: 0 }
      }));
      const res = await window.api.invoke('file:download', { file_id: fileId, host_ip: hostIp, host_port: hostPort });
      // 用户取消保存对话框：回滚状态为 pending
      if (res && res.canceled) {
        set((state) => ({
          status: { ...state.status, [fileId]: 'pending' },
          progress: { ...state.progress, [fileId]: 0 }
        }));
      }
    },

    // 断点续传：复用已下载分片；无有效分片时回退为全新下载
    resume: async (fileId, hostIp, hostPort) => {
      set((state) => ({
        status: { ...state.status, [fileId]: 'downloading' },
        progress: { ...state.progress, [fileId]: 0 }
      }));
      const res = await window.api.invoke('file:resume', { file_id: fileId, host_ip: hostIp, host_port: hostPort });
      if (res && res.ok === false) {
        // 无可续传分片：回退为全新下载（会弹保存对话框）
        await get().download(fileId, hostIp, hostPort);
      }
    },

    setProgress: (fileId, progress) => {
      set((state) => ({ progress: { ...state.progress, [fileId]: progress } }));
    },

    setComplete: (fileId, storagePath) => {
      set((state) => ({
        status: { ...state.status, [fileId]: 'completed' },
        progress: { ...state.progress, [fileId]: 1 },
        storagePath: { ...state.storagePath, [fileId]: storagePath }
      }));
    },

    setFailed: (fileId) => {
      set((state) => ({ status: { ...state.status, [fileId]: 'failed' } }));
    },

    // 从 DB 恢复文件状态（打开会话时调用，避免重启后状态丢失）
    loadSessionFiles: async (sessionId) => {
      try {
        const files = await window.api.invoke('file:list-session', sessionId);
        if (!files || files.length === 0) return;
        set((state) => {
          const status = { ...state.status };
          const storagePath = { ...state.storagePath };
          for (const f of files) {
            // 仅恢复非临时状态（completed/failed），不覆盖正在进行的下载
            if (f.download_status === 'completed' || f.download_status === 'failed') {
              if (!status[f.file_id] || status[f.file_id] === 'pending') {
                status[f.file_id] = f.download_status;
                if (f.storage_path) storagePath[f.file_id] = f.storage_path;
              }
            }
          }
          return { status, storagePath };
        });
      } catch {}
    }
  }))
);
