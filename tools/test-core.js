// chat-core.js 的单元测试（不需要浏览器）
// 用法：node tools/test-core.js
'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', 'chat-core.js'));

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + label);
  } else {
    fail++;
    console.log('FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  }
}

// 1. 空内容
{
  const c = core.createChat({ now: () => 1000 });
  ok(c.addOutgoing('   ').ok === false, '拒绝空内容');
  ok(c.messages().length === 0, '空内容不入库');
}

// 2. 发出的消息先处于 sending
{
  const c = core.createChat({ now: () => 1000 });
  const r = c.addOutgoing('你好', false);
  ok(r.ok && r.message.status === 'sending', '发出后状态 sending');
  ok(c.pendingCount() === 1, '计入待回执');
  ok(c.messages().length === 1 && c.messages()[0].side === 'me', '落在自己这一侧');
}

// 3. 收到 ack -> delivered
{
  const c = core.createChat({ now: () => 1000 });
  const m = c.addOutgoing('在吗', false).message;
  ok(c.onAck(m.id) === true, 'ack 生效');
  ok(c.messages()[0].status === 'delivered', '状态变 delivered');
  ok(c.pendingCount() === 0, '待回执清空');
  ok(c.onAck(m.id) === false, '重复 ack 不重复生效');
}

// 4. 收到消息 + 已读回执
{
  const c = core.createChat({ now: () => 2000 });
  const got = c.receive({ id: 'x1', text: '在', ts: 1500 });
  ok(got && got.side === 'peer' && got.text === '在', '收到对方消息');
  ok(c.takeSeenIds().length === 1, '产生一条待上报已读');
  ok(c.takeSeenIds().length === 0, '取过一次就清空');

  const mine = c.addOutgoing('好', false).message;
  c.onAck(mine.id);
  ok(c.onSeen([mine.id]) === 1, '对方已读回执生效');
  ok(c.messages().find((m) => m.id === mine.id).status === 'read', '状态变 read');
  ok(c.onSeen([mine.id]) === 0, '重复回执不重复计数');
}

// 5. 焚毁
{
  const c = core.createChat();
  const got = c.receive({ id: 'b1', text: '看完就没了' });
  ok(got.burn === false, 'burn 默认 false');
  const burnMsg = c.receive({ id: 'b2', text: '焚', burn: true });
  ok(burnMsg.burn === true, 'burn 标记透传');
  ok(c.burn('b2') === true, '焚毁成功');
  ok(c.messages().every((m) => m.id !== 'b2'), '焚毁后不再可见');
  ok(c.burn('b2') === false, '重复焚毁返回 false');
  ok(c.takeSeenIds().indexOf('b2') === -1, '焚毁的消息不再上报已读');
}

// 6. 断线：pending 全部标失败
{
  const c = core.createChat();
  c.addOutgoing('一', false);
  c.addOutgoing('二', false);
  const n = c.failPending();
  ok(n === 2, '两条未回执的都标失败', n);
  ok(c.messages().every((m) => m.status === 'failed'), '状态是 failed');
  ok(c.pendingCount() === 0, '待回执清空');
}

// 7. 超长与截断
{
  const c = core.createChat({ maxLength: 10 });
  ok(c.addOutgoing('x'.repeat(11), false).ok === false, '超过上限被拒');
  ok(c.addOutgoing('x'.repeat(10), false).ok === true, '等于上限可以发');
  const long = c.receive({ id: 'l1', text: 'y'.repeat(50) });
  ok(long.text.length === 10, '收到的超长内容被截断');
}

// 8. reset
{
  const c = core.createChat();
  c.addOutgoing('hi', false);
  c.receive({ id: 'q', text: 'yo' });
  c.reset();
  ok(c.messages().length === 0 && c.pendingCount() === 0, 'reset 清空');
}

// 9. 协议封装
{
  const p = core.pack('msg', { id: 'a1', text: 'x' });
  ok(p.t === 'msg' && p.id === 'a1' && p.p === core.PROTOCOL, 'pack 结构正确');
  ok(core.parse(p) === p, 'parse 接受合法消息');
  ok(core.parse(null) === null && core.parse({}) === null && core.parse('x') === null, 'parse 拒绝垃圾');
}

// 10. 消息条数上限
{
  const c = core.createChat();
  for (let i = 0; i < 320; i++) c.receive({ id: 'k' + i, text: 'n' + i });
  ok(c.messages().length === 300, '最多保留 300 条', c.messages().length);
}

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
