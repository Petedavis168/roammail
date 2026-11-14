// Messages between app servers through PostgreSQL (LISTEN/NOTIFY), for setups without Redis: live updates (typing,
// read ticks, team inboxes), sign-out-everywhere and cache clearing reach people on every server, not just one.
// One extra database connection per server; messages over 7.5 KB are dropped (live events are tiny).
import { dialect, pgPool } from './db.js';
import { usingRedis, setBusPublisher, receiveBus } from './shared.js';

const CHANNEL = 'roammail_bus';
export async function startPgBus(pool = pgPool) {
  if (dialect !== 'postgres' || usingRedis() || !pool) return false;
  let listener = null;
  const connect = async () => {
    try {
      listener = await pool.connect();
      listener.on('notification', (m) => { if (m.channel === CHANNEL && m.payload) receiveBus(m.payload); });
      listener.on('error', () => retry());
      await listener.query(`LISTEN ${CHANNEL}`);
    } catch (e) { console.warn('pg bus: listen failed,', e.code || e.message); retry(); }
  };
  let timer = null;
  const retry = () => {
    if (timer) return;
    try { listener?.release(true); } catch { /* already gone */ }
    listener = null;
    timer = setTimeout(() => { timer = null; connect(); }, 5000);
    timer.unref?.();
  };
  await connect();
  setBusPublisher((msg) => {
    if (Buffer.byteLength(msg) > 7500) return console.warn('pg bus: message too large, not sent to other servers');
    pool.query('SELECT pg_notify($1, $2)', [CHANNEL, msg]).catch((e) => console.warn('pg bus: notify failed,', e.code || e.message));
  });
  return true;
}
