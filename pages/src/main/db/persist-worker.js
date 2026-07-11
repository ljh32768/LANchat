// DB 持久化 worker：承接 sql.js export 后的同步写盘，避免阻塞主线程事件循环
// 主线程做 db.export()（WASM 同步，快），把 buffer transfer 给本 worker 做 writeFileSync + rename
const { parentPort } = require('worker_threads');
const fs = require('fs');

parentPort.on('message', ({ buffer, tmpPath, dbPath }) => {
  try {
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
    fs.renameSync(tmpPath, dbPath);
    parentPort.postMessage({ ok: true });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
});
