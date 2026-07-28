/**
 * Multi-site (multi-brand) behaviour: the team lead defines the sites and who
 * handles which, and operators are hard-isolated to their own brands.
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (r) => r.json();
const asOp = (opId, extra = {}) => ({ 'Content-Type': 'application/json', 'x-operator-id': opId, ...extra });

/* 1. Team lead + operator */
const { operator: admin } = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Анна', email: 'lead@test.ru' }),
}).then(json);
check('first login becomes team lead', admin.role === 'admin');

const bLogin = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Борис', email: 'boris@test.ru' }),
}).then(json);
const boris = bLogin.operator;
check('second operator is not a lead', boris.role === 'operator');
check('operator starts with no sites', bLogin.sites.length === 0);

/* 2. Settings API is lead-only */
const forbidden = await fetch(BASE + '/api/operators', { headers: { 'x-operator-id': boris.id } });
check('settings API blocked for non-lead', forbidden.status === 403);

/* 3. Lead creates the brands */
const brands = {};
for (const name of ['Casino Royal', 'LuckyStar', 'GoldenBet', 'NeonSpin']) {
  const { site } = await fetch(BASE + '/api/sites', {
    method: 'POST', headers: asOp(admin.id), body: JSON.stringify({ name }),
  }).then(json);
  brands[name] = site;
}
check('lead created 4 sites', Object.keys(brands).length === 4);
check('each site gets its own widget key', new Set(Object.values(brands).map((s) => s.key)).size === 4);

/* 4. Lead assigns 2 of them to the operator */
const setSites = (siteIds) => fetch(BASE + `/api/operators/${boris.id}/sites`, {
  method: 'PUT', headers: asOp(admin.id), body: JSON.stringify({ siteIds }),
});
await setSites([brands['Casino Royal'].id, brands['LuckyStar'].id]);

/* 5. Operator connects */
const bSock = io(BASE, { auth: { role: 'operator', operatorId: boris.id } });
let bSites = [], bInbox = [], bHistory = null, bTyping = null;
bSock.on('sites:list', (s) => { bSites = s; });
bSock.on('inbox:list', (r) => { bInbox = r; });
bSock.on('conversation:history', (h) => { bHistory = h; });
bSock.on('visitor:typing', (t) => { bTyping = t; });
await new Promise((r) => bSock.on('connect', r));
await wait(300);
check('operator receives only assigned sites', bSites.length === 2);

/* 6. Visitors across three brands */
async function visitor(siteKey, text) {
  const sock = io(BASE, { auth: { role: 'visitor' } });
  let session = null; const got = [];
  sock.on('visitor:session', (s) => { session = s; });
  sock.on('message:new', (m) => got.push(m));
  await new Promise((r) => sock.on('connect', r));
  sock.emit('visitor:init', { siteKey, page: { url: 'https://demo.test/', title: 'Demo' } });
  await wait(250);
  if (text) { sock.emit('visitor:message', { body: text }); await wait(250); }
  return { sock, session: () => session, got: () => got };
}

const vRoyal = await visitor(brands['Casino Royal'].key, 'Привет из Casino Royal');
const vLucky = await visitor(brands['LuckyStar'].key, 'Привет из LuckyStar');
const vGolden = await visitor(brands['GoldenBet'].key, 'Привет из GoldenBet');
await wait(400);

check('visitor session carries its brand', vRoyal.session()?.site?.name === 'Casino Royal');
const siteIdsInInbox = new Set(bInbox.map((c) => c.site_id));
check('inbox contains assigned brands', siteIdsInInbox.has(brands['Casino Royal'].id) && siteIdsInInbox.has(brands['LuckyStar'].id));
check('inbox EXCLUDES unassigned brand', !siteIdsInInbox.has(brands['GoldenBet'].id));
check('inbox rows carry site name for the dividers', bInbox.every((c) => !!c.site_name));

/* 7. Hard isolation */
const goldenConv = vGolden.session().conversationId;
bHistory = null;
bSock.emit('operator:open', { conversationId: goldenConv });
await wait(300);
check('cannot open an unassigned conversation', bHistory === null);

const before = vGolden.got().length;
bSock.emit('operator:message', { conversationId: goldenConv, body: 'НЕ ДОЛЖНО ДОЙТИ' });
await wait(300);
check('cannot reply into an unassigned conversation', vGolden.got().length === before);

bTyping = null;
vGolden.sock.emit('visitor:typing', { text: 'текст чужого бренда' });
await wait(250);
check('typing preview of another brand is not leaked', bTyping === null);

/* 8. Serving an assigned brand */
const royalConv = vRoyal.session().conversationId;
bSock.emit('operator:open', { conversationId: royalConv });
await wait(300);
check('can open an assigned conversation', bHistory?.conversation?.id === royalConv);
check('history carries site info', bHistory?.site?.name === 'Casino Royal');

bSock.emit('operator:message', { conversationId: royalConv, body: 'Оператор Casino Royal на связи.' });
await wait(300);
check('reply reaches the right visitor', vRoyal.got().some((m) => m.sender_type === 'operator'));
check('reply does not leak to another brand', !vLucky.got().some((m) => m.sender_type === 'operator'));

vRoyal.sock.emit('visitor:typing', { text: 'печатаю в Royal' });
await wait(250);
check('typing preview of assigned brand delivered', bTyping?.text === 'печатаю в Royal');

/* 9. Live re-assignment, no reconnect */
await setSites([brands['Casino Royal'].id, brands['LuckyStar'].id, brands['GoldenBet'].id]);
await wait(400);
check('sites update live when the lead grants access', bSites.length === 3);
check('inbox picks up the newly granted brand', new Set(bInbox.map((c) => c.site_id)).has(brands['GoldenBet'].id));

await setSites([brands['Casino Royal'].id]);
await wait(400);
check('revoking access removes the brand live', bSites.length === 1);
check('revoked brand disappears from the inbox', !new Set(bInbox.map((c) => c.site_id)).has(brands['GoldenBet'].id));

/* 10. Presence is per brand */
const vRoyal2 = await visitor(brands['Casino Royal'].key, null);
const vNeon = await visitor(brands['NeonSpin'].key, null);
check('staffed brand shows operator online', vRoyal2.session().operatorOnline === true);
check('unstaffed brand shows operator offline', vNeon.session().operatorOnline === false);

/* 11. Robustness */
const vBad = await visitor('st_doesnotexist', null);
check('unknown site key falls back instead of crashing', !!vBad.session()?.conversationId);

for (const v of [vRoyal, vLucky, vGolden, vRoyal2, vNeon, vBad]) v.sock.close();
bSock.close();

const passed = results.filter(([, c]) => c).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
