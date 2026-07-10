// 发送者身份防伪造层级解析
// 输入：发送者 { contact_id, nickname, ip }，在线用户列表 peers，联系人列表 contacts
//       showIp：是否在显示中包含 IP（联系人列表 false，会话内消息气泡 true）
// 输出：{ level, text, segs: [{text, cls}], tooltip }
// showIp=true：昵称 (id前6位, ip)；showIp=false：昵称 (id前6位)

export function resolveIdentity(sender, peers = [], contacts = [], showIp = true) {
  const id = sender?.contact_id || sender?.sender_contact_id || '';
  const nick = sender?.nickname || sender?.sender_nickname || findContactNickname(id, contacts) || '未知';
  const ip = sender?.ip || sender?.sender_ip || '';

  const idShort = id ? id.slice(0, 6) : '------';
  const ipText = ip || '未知';

  // 同昵称的在线用户数
  const sameNickCount = peers.filter((p) => p.nickname === nick).length;
  // 同 client_id 但不同 IP 的联系人记录（疑似伪造）
  const contact = contacts.find((c) => c.contact_id === id);
  const ipMismatch = contact && contact.last_seen_ip && ip && contact.last_seen_ip !== ip;

  // level 3 的判定仍需 IP（即使不展示），tooltip 照常提示 IP 不匹配
  if (sameNickCount > 1 && ipMismatch) {
    return {
      level: 3,
      nick,
      segs: showIp
        ? [
            { text: nick + ' ', cls: 'id-name' },
            { text: `(${idShort}, `, cls: 'id-id' },
            { text: ipText, cls: 'id-ip' },
            { text: ')', cls: 'id-id' }
          ]
        : [
            { text: nick + ' ', cls: 'id-name' },
            { text: `(${idShort})`, cls: 'id-id' }
          ],
      tooltip: '该用户ID与另一用户相同，可能为伪造身份，已通过IP区分'
    };
  }
  // level 1 / 2
  return {
    level: sameNickCount > 1 ? 2 : 1,
    nick,
    segs: showIp
      ? [
          { text: nick + ' ', cls: 'id-name' },
          { text: `(${idShort}, `, cls: 'id-id' },
          { text: ipText, cls: 'id-ip' },
          { text: ')', cls: 'id-id' }
        ]
      : [
          { text: nick + ' ', cls: 'id-name' },
          { text: `(${idShort})`, cls: 'id-id' }
        ],
    tooltip: null
  };
}

function findContactNickname(id, contacts) {
  const c = contacts.find((x) => x.contact_id === id);
  return c?.nickname || c?.alias || null;
}
