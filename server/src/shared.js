// State shared between app servers. With REDIS_URL set (several servers behind a load balancer), rate limits,
// sign-in throttling and cross-server messages (sign-out-everywhere, cache invalidation) go through Redis.
// Without it, everything stays in this process, which is right for a single server.
import { EventEmitter } from 'node:events';
import expressRateLimit from 'express-rate-limit';
import { config } from './config.js';

let client = null; let sub = null;
const local = new EventEmitter();
local.setMaxListeners(50);
const SERVER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

if (config.redisUrl) {
  const { createClient } = await import('redis');
  const opts = { url: config.redisUrl, socket: { reconnectStrategy: (n) => Math.min(n * 200, 5000) } };
  client = createClient(opts);
  client.on('error', (e) => console.error('APP_ERROR redis', e.message));
  sub = client.duplicate();
  sub.on('error', (e) => console.error('APP_ERROR redis (subscriber)', e.message));
  await Promise.all([client.connect(), sub.connect()]);
  await sub.subscribe('roammail', (raw) => {
    try {
      const { from, channel, data } = JSON.parse(raw);
      if (from !== SERVER_ID) local.emit(channel, data);
    } catch { /* ignore malformed */ }
  });
}
export const usingRedis = () => !!client;
export const redis = () => client;

// ---------------------------------------------------------------- messages to every server
/** Run fn(data) on every server (including this one) when broadcast(channel, data) is called anywhere. */
export function onBroadcast(channel, fn) { local.on(channel, fn); }
export function broadcast(channel, data) {
  local.emit(channel, data);
  if (client) client.publish('roammail', JSON.stringify({ from: SERVER_ID, channel, data })).catch((e) => console.error('APP_ERROR redis publish', e.message));
}

// ---------------------------------------------------------------- rate limiting (drop-in for express-rate-limit)
let limiterSeq = 0;
export function rateLimit(opts) {
  const o = { standardHeaders: true, legacyHeaders: false, ...opts };
  if (client) {
    const prefix = `rl:${++limiterSeq}:`; // same code => same order on every server => same names
    o.store = new RedisStoreLazy(prefix);
    o.passOnStoreError = true; // if Redis is briefly down, don't lock everyone out
  }
  return expressRateLimit(o);
}
// rate-limit-redis is loaded lazily so single-server installs don't need it at all
let RedisStoreClass = null;
if (config.redisUrl) RedisStoreClass = (await import('rate-limit-redis')).RedisStore;
class RedisStoreLazy {
  constructor(prefix) { this.inner = new RedisStoreClass({ prefix, sendCommand: (...args) => client.sendCommand(args) }); this.prefix = prefix; }
  init(options) { return this.inner.init(options); }
  get(key) { return this.inner.get(key); }
  increment(key) { return this.inner.increment(key); }
  decrement(key) { return this.inner.decrement(key); }
  resetKey(key) { return this.inner.resetKey(key); }
}

// ---------------------------------------------------------------- small counters with expiry (sign-in throttling)
const mem = new Map(); // key -> { n, exp }
setInterval(() => { const now = Date.now(); for (const [k, v] of mem) if (v.exp < now) mem.delete(k); }, 60_000).unref();
export const counter = {
  /** Add 1 and return the new count; the window starts with the first hit. */
  async hit(key, windowMs) {
    if (client) {
      const k = `c:${key}`;
      const n = await client.incr(k);
      if (n === 1) await client.pExpire(k, windowMs);
      return n;
    }
    const now = Date.now(); let v = mem.get(key);
    if (!v || v.exp < now) { v = { n: 0, exp: now + windowMs }; mem.set(key, v); }
    return ++v.n;
  },
  async set(key, value, ttlMs) {
    if (client) { await client.set(`c:${key}`, String(value), { PX: ttlMs }); return; }
    mem.set(key, { n: value, exp: Date.now() + ttlMs });
  },
  async get(key) {
    if (client) { const v = await client.get(`c:${key}`); return v === null ? 0 : Number(v); }
    const v = mem.get(key); return v && v.exp > Date.now() ? v.n : 0;
  },
  async del(key) { if (client) await client.del(`c:${key}`); else mem.delete(key); },
};

export async function closeShared() { await Promise.allSettled([client?.quit(), sub?.quit()]); }
