/**
 * Core chat flow: visitor ↔ operator messaging, live typing preview,
 * visitor enrichment, rating, closing. Runs against a fresh server/DB.
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// First login on a fresh database bootstraps the team lead (sees every site).
const { operator } = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Анна', email: 'anna@test.ru' }),
}).then((r) => r.json());
check('operator login', !!operator?.id);
check('first operator becomes team lead', operator.role === 'admin');

const opSock = io(BASE, { auth: { role: 'operator', operatorId: operator.id } });
let inbox = [], opGotMessage = null, opGotTyping = null, opHistory = null;
opSock.on('inbox:list', (rows) => { inbox = rows; });
opSock.on('message:new', (m) => { opGotMessage = m; });
opSock.on('visitor:typing', (d) => { opGotTyping = d; });
opSock.on('conversation:history', (h) => { opHistory = h; });
await new Promise((r) => opSock.on('connect', r));
check('operator socket connected', opSock.connected);

const visSock = io(BASE, { auth: { role: 'visitor' } });
let session = null, visGotMessage = null;
visSock.on('visitor:session', (s) => { session = s; });
visSock.on('message:new', (m) => { visGotMessage = m; });
await new Promise((r) => visSock.on('connect', r));
visSock.emit('visitor:init', {
  page: {
    url: 'http://shop.test/product/42',
    title: 'Куртка',
    referrer: 'https://yandex.ru/search/?text=купить+куртку',
  },
});
await wait(300);
check('visitor session created', !!session?.conversationId);
const convId = session?.conversationId;

visSock.emit('visitor:typing', { text: 'печатаю вопрос про' });
await wait(200);
check('operator sees live typing preview', opGotTyping?.text === 'печатаю вопрос про' && opGotTyping?.conversationId === convId);

visSock.emit('visitor:message', { body: 'Здравствуйте, есть ли размер L?' });
await wait(300);
check('operator receives visitor message', opGotMessage?.body === 'Здравствуйте, есть ли размер L?' && opGotMessage?.sender_type === 'visitor');
check('inbox has the conversation', inbox.some((c) => c.id === convId && c.unread >= 1));

opSock.emit('operator:open', { conversationId: convId });
await wait(300);
check('operator gets history', Array.isArray(opHistory?.messages) && opHistory.messages.length >= 1);
check('visitor enriched: search source', /Яндекс/i.test(opHistory?.visitor?.referrer || ''));
check('visitor enriched: search query kept', /куртку/i.test(opHistory?.visitor?.search_query || ''));

opSock.emit('operator:message', { conversationId: convId, body: 'Здравствуйте! Да, размер L в наличии.' });
await wait(300);
check('visitor receives operator reply', visGotMessage?.body === 'Здравствуйте! Да, размер L в наличии.' && visGotMessage?.sender_type === 'operator');

visSock.emit('visitor:profile', { name: 'Иван', email: 'ivan@test.ru' });
await wait(300);
check('visitor profile propagates to inbox', inbox.some((c) => c.id === convId && c.visitor_name === 'Иван'));

visSock.emit('visitor:rate', { rating: 5, comment: 'Спасибо!' });
await wait(300);
check('rating recorded as system message', opGotMessage?.sender_type === 'system' && /5\/5/.test(opGotMessage?.body || ''));

let closed = false;
visSock.on('conversation:closed', () => { closed = true; });
opSock.emit('operator:close', { conversationId: convId });
await wait(300);
check('closing notifies the visitor', closed);

opSock.close(); visSock.close();
const passed = results.filter(([, c]) => c).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
