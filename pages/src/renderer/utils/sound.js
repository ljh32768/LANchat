/**
 * 渲染进程轻微提示音（与系统桌面通知解耦）
 *
 * 设计说明：
 * - 主进程 Notification 使用 silent:true，避免系统默认提示音与本提示音叠音
 * - 在 useIpcEvents 中：仅当窗口未聚焦且设置允许时调用 playMessageSound()
 * - 使用 WebAudio 合成，无需额外音频资源文件
 *
 * 示例（已在 hooks/useIpcEvents.js 集成）：
 *   import { playMessageSound } from '../utils/sound';
 *   if (!document.hasFocus() && soundEnabled) playMessageSound();
 *
 * 若要改用静态音频文件：
 *   const audio = new Audio('notify.mp3');
 *   audio.volume = 0.3;
 *   audio.play().catch(() => {});
 */

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  return ctx;
}

/** 播放一条短促的科幻电子提示音 */
export function playMessageSound() {
  const c = getCtx();
  if (!c) return;

  // 浏览器/Electron 可能在无用户手势时挂起 AudioContext，收到消息时尝试恢复
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
  }

  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  // 880Hz → 1320Hz 上滑，约 0.3s 衰减
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.34);
}
