/**
 * Operator authentication: first-run setup, sign-in, session cookies, the
 * private operator area, and the lead's control over employee accounts.
 */
import { io } from 'socket.io-client';
import { req, setupLead, login, socketAuth, wait, makeChecker } from './helpers.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];
const check = makeChecker(results);

const LEAD = { name: 'Анна', email: 'lead@qdesk.test', password: 'sup3r-secret' };

/* 1. Fresh install asks for setup, and the panel is closed to anonymous users */
const state0 = await req(BASE, '/api/auth/state').then((r) => r.json());
check('fresh install needs setup', state0.needsSetup === true && state0.authenticated === false);

const anonPanel = await req(BASE, '/operator/', { redirect: 'manual' });
check('anonymous /operator/ redirects to login',
  anonPanel.status === 302 && (anonPanel.headers.get('location') || '').includes('/login/'));

const anonMe = await req(BASE, '/api/me');
check('anonymous /api/me is 401', anonMe.status === 401);

/* 2. Setup creates the lead and signs them in */
const lead = await setupLead(BASE, LEAD);
check('setup returns the lead account', lead.operator?.role === 'admin');
check('setup issues a session cookie', !!lead.cookie);
check('setup never leaks the password hash', lead.operator && !('password_hash' in lead.operator));

const state1 = await req(BASE, '/api/auth/state').then((r) => r.json());
check('setup closes once an account exists', state1.needsSetup === false);

const setupAgain = await req(BASE, '/api/auth/setup', {
  method: 'POST', body: { name: 'Злоумышленник', email: 'evil@qdesk.test', password: 'password123' },
});
check('second setup attempt is refused', setupAgain.status === 403);

/* 3. Sessions */
const me = await req(BASE, '/api/me', { cookie: lead.cookie }).then((r) => r.json());
check('/api/me works with the session cookie', me.operator?.email === LEAD.email);

const panelOk = await req(BASE, '/operator/', { cookie: lead.cookie, redirect: 'manual' });
check('signed-in operator reaches the panel', panelOk.status === 200);

const loginPageRedirect = await req(BASE, '/login/', { cookie: lead.cookie, redirect: 'manual' });
check('signed-in operator skips the login page',
  loginPageRedirect.status === 302 && (loginPageRedirect.headers.get('location') || '').includes('/operator/'));

const badPw = await login(BASE, LEAD.email, 'wrong-password');
check('wrong password is rejected', badPw.status === 401 && !badPw.cookie);

const unknownUser = await login(BASE, 'nobody@qdesk.test', 'whatever1');
check('unknown email is rejected the same way', unknownUser.status === 401);

const forgedCookie = await req(BASE, '/api/me', { cookie: 'qdesk_session=made-up-token' });
check('forged session token is rejected', forgedCookie.status === 401);

/* 4. Sockets authenticate from the cookie, not from client claims */
async function trySocket(cookie) {
  const sock = io(BASE, socketAuth(cookie));
  const outcome = await new Promise((resolve) => {
    const done = (v) => resolve(v);
    sock.on('sites:list', () => done('authorised'));
    sock.on('error:auth', () => done('rejected'));
    sock.on('connect_error', () => done('rejected'));
    setTimeout(() => done('timeout'), 2500);
  });
  sock.close();
  return outcome;
}
check('socket without a session is rejected', (await trySocket(null)) === 'rejected');
check('socket with a valid session is accepted', (await trySocket(lead.cookie)) === 'authorised');

/* 5. The lead creates employee accounts (there is no public sign-up) */
const created = await req(BASE, '/api/operators', {
  method: 'POST', cookie: lead.cookie,
  body: { name: 'Борис', email: 'boris@qdesk.test', password: 'boris-pass-1' },
}).then((r) => r.json());
check('lead can create an employee', created.operator?.role === 'operator');

const dupe = await req(BASE, '/api/operators', {
  method: 'POST', cookie: lead.cookie,
  body: { name: 'Борис 2', email: 'boris@qdesk.test', password: 'another-pass' },
});
check('duplicate email is refused', dupe.status === 409);

const weak = await req(BASE, '/api/operators', {
  method: 'POST', cookie: lead.cookie,
  body: { name: 'Слабый', email: 'weak@qdesk.test', password: '123' },
});
check('short password is refused', weak.status === 400);

const boris = await login(BASE, 'boris@qdesk.test', 'boris-pass-1');
check('employee can sign in', boris.status === 200 && !!boris.cookie);

const borisAdminApi = await req(BASE, '/api/operators', { cookie: boris.cookie });
check('employee cannot reach the lead-only API', borisAdminApi.status === 403);

const borisCreate = await req(BASE, '/api/operators', {
  method: 'POST', cookie: boris.cookie,
  body: { name: 'Свой человек', email: 'friend@qdesk.test', password: 'password123' },
});
check('employee cannot create accounts', borisCreate.status === 403);

/* 6. Password reset kicks the employee out */
const borisSock = io(BASE, socketAuth(boris.cookie));
let kicked = false;
borisSock.on('error:auth', () => { kicked = true; });
await new Promise((r) => borisSock.on('connect', r));
await wait(300);

await req(BASE, `/api/operators/${created.operator.id}/password`, {
  method: 'POST', cookie: lead.cookie, body: { password: 'brand-new-pass' },
});
await wait(400);
check('password reset disconnects the live session', kicked);
borisSock.close();

const staleCookie = await req(BASE, '/api/me', { cookie: boris.cookie });
check('old session stops working after a reset', staleCookie.status === 401);
const oldPw = await login(BASE, 'boris@qdesk.test', 'boris-pass-1');
check('old password no longer works', oldPw.status === 401);
const newPw = await login(BASE, 'boris@qdesk.test', 'brand-new-pass');
check('new password works', newPw.status === 200);

/* 7. Deactivation */
await req(BASE, `/api/operators/${created.operator.id}/active`, {
  method: 'POST', cookie: lead.cookie, body: { active: false },
});
const disabledLogin = await login(BASE, 'boris@qdesk.test', 'brand-new-pass');
check('disabled account cannot sign in', disabledLogin.status === 403);
check('disabled account session is dropped',
  (await req(BASE, '/api/me', { cookie: newPw.cookie })).status === 401);

await req(BASE, `/api/operators/${created.operator.id}/active`, {
  method: 'POST', cookie: lead.cookie, body: { active: true },
});
check('re-enabled account can sign in again',
  (await login(BASE, 'boris@qdesk.test', 'brand-new-pass')).status === 200);

const selfDisable = await req(BASE, `/api/operators/${lead.operator.id}/active`, {
  method: 'POST', cookie: lead.cookie, body: { active: false },
});
check('lead cannot disable themselves', selfDisable.status === 400);

/* 8. Changing your own password */
const wrongCurrent = await req(BASE, '/api/auth/password', {
  method: 'POST', cookie: lead.cookie, body: { current: 'nope', next: 'a-new-password' },
});
check('self password change needs the current one', wrongCurrent.status === 400);

const changed = await req(BASE, '/api/auth/password', {
  method: 'POST', cookie: lead.cookie, body: { current: LEAD.password, next: 'a-new-password' },
});
check('self password change succeeds', changed.status === 200);
check('lead signs in with the new password',
  (await login(BASE, LEAD.email, 'a-new-password')).status === 200);

/* 9. Logout */
const fresh = await login(BASE, LEAD.email, 'a-new-password');
await req(BASE, '/api/auth/logout', { method: 'POST', cookie: fresh.cookie });
check('logout invalidates the session', (await req(BASE, '/api/me', { cookie: fresh.cookie })).status === 401);

const passed = results.filter(([, c]) => c).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
