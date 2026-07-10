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
    }
  }))
);
