// history/store.js · 历史信号本地存储(浏览器 IndexedDB;无 indexedDB 时回退内存实现)
// 表结构见 history/schema.js;所有写入都是幂等 put,key 由记录本身决定
import { ALL_TABLES, SIGNAL_TABLE, SIGNAL_OUTCOME_TABLE } from "./schema.js";

const DB_NAME = "quant_history";
// v2: walkforward 表 · v3: V14 paper/learning/sync · v4: V15 通知历史 · v5: V15 运行时命令邮箱
// 注意:新增表必须同步升版本号!否则已升级过的库再用旧版本号 open 会抛 VersionError
// (那会让存储层退化,引擎读不到账户 → 看起来像"账户被重置")
const DB_VERSION = 5;

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

// ---- IndexedDB 实现 ----
function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const table of ALL_TABLES) {
        let store;
        if (db.objectStoreNames.contains(table.name)) store = open.transaction.objectStore(table.name);
        else store = db.createObjectStore(table.name, { keyPath: table.key });
        for (const idx of table.indexes || []) {
          const keyPath = idx.key;
          if (!store.indexNames.contains(idx.name)) store.createIndex(idx.name, keyPath, { unique: false });
        }
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      // 自愈迁移:若旧库缺少任何新表(版本号未同步升级),关闭并以更高版本重开一次
      const missing = ALL_TABLES.filter((t) => !db.objectStoreNames.contains(t.name));
      if (missing.length && !open.__retried) {
        const nextVersion = db.version + 1;
        db.close();
        const retry = indexedDB.open(DB_NAME, nextVersion);
        retry.onupgradeneeded = () => {
          const rdb = retry.result;
          for (const table of ALL_TABLES) {
            let store;
            if (rdb.objectStoreNames.contains(table.name)) store = retry.transaction.objectStore(table.name);
            else store = rdb.createObjectStore(table.name, { keyPath: table.key });
            for (const idx of table.indexes || []) {
              if (!store.indexNames.contains(idx.name)) store.createIndex(idx.name, idx.key, { unique: false });
            }
          }
        };
        retry.onsuccess = () => resolve(retry.result);
        retry.onerror = () => reject(retry.error || new Error("indexeddb_retry_failed"));
        // 关键:其它连接(另一个标签页/旧连接)会阻塞升级。必须处理,否则 open 永远不回调,
        // 上层会退化成"空存储",表现成账户被重置。
        retry.onblocked = () => {
          reject(new Error("indexeddb_blocked_by_other_connection"));
        };
        return;
      }
      resolve(db);
    };
    open.onerror = () => {
      const error = open.error;
      // 版本落后(库已被自愈升到更高版本):以"最新版本"重开一次,而不是直接失败
      if (error && String(error.name) === "VersionError") {
        const latest = indexedDB.open(DB_NAME);
        latest.onsuccess = () => resolve(latest.result);
        latest.onerror = () => reject(latest.error || error);
        return;
      }
      reject(error);
    };
    open.onblocked = () => reject(new Error("indexeddb_blocked_by_other_connection"));
  });
}

function idbStore(db) {
  return {
    async put(table, record) {
      const tx = db.transaction(table, "readwrite");
      tx.objectStore(table).put(record);
      await txDone(tx);
      return record;
    },
    async putMany(table, records) {
      if (!records || !records.length) return 0;
      const tx = db.transaction(table, "readwrite");
      const store = tx.objectStore(table);
      for (const r of records) store.put(r);
      await txDone(tx);
      return records.length;
    },
    async get(table, key) {
      const tx = db.transaction(table, "readonly");
      return req(tx.objectStore(table).get(key));
    },
    async all(table, limit) {
      const tx = db.transaction(table, "readonly");
      const store = tx.objectStore(table);
      const out = [];
      return new Promise((resolve, reject) => {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(out); return; }
          out.push(cursor.value);
          if (limit && out.length >= limit) { resolve(out); return; }
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    },
    async byIndex(table, indexName, value, limit) {
      const tx = db.transaction(table, "readonly");
      const idx = tx.objectStore(table).index(indexName);
      const out = [];
      return new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(value);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(out); return; }
          out.push(cursor.value);
          if (limit && out.length >= limit) { resolve(out); return; }
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    },
    async del(table, key) {
      const tx = db.transaction(table, "readwrite");
      tx.objectStore(table).delete(key);
      await txDone(tx);
    },
    async delMany(table, keys) {
      if (!keys || !keys.length) return 0;
      const tx = db.transaction(table, "readwrite");
      const store = tx.objectStore(table);
      for (const k of keys) store.delete(k);
      await txDone(tx);
      return keys.length;
    },
    async clear(table) {
      const tx = db.transaction(table, "readwrite");
      tx.objectStore(table).clear();
      await txDone(tx);
    },
    async count(table) {
      const tx = db.transaction(table, "readonly");
      return req(tx.objectStore(table).count());
    }
  };
}

// ---- 内存实现(测试 / IndexedDB 不可用时) ----
function memoryBackend() {
  const data = new Map();
  for (const table of ALL_TABLES) data.set(table.name, new Map());
  return {
    async put(table, record) {
      const key = record[ALL_TABLES.find((t) => t.name === table).key];
      data.get(table).set(key, record);
      return record;
    },
    async putMany(table, records) {
      for (const r of records || []) await this.put(table, r);
      return (records || []).length;
    },
    async get(table, key) {
      return data.get(table).get(key) || null;
    },
    async all(table, limit) {
      const out = [...data.get(table).values()];
      return limit ? out.slice(0, limit) : out;
    },
    async byIndex(table, indexName, value, limit) {
      const tableDef = ALL_TABLES.find((t) => t.name === table);
      const idx = (tableDef.indexes || []).find((i) => i.name === indexName);
      if (!idx) return [];
      const keys = Array.isArray(idx.key) ? idx.key : [idx.key];
      const vals = Array.isArray(value) ? value : [value];
      const out = [...data.get(table).values()].filter((rec) => keys.every((k, i) => rec[k] === vals[i]));
      return limit ? out.slice(0, limit) : out;
    },
    async del(table, key) {
      data.get(table).delete(key);
    },
    async delMany(table, keys) {
      for (const k of keys || []) data.get(table).delete(k);
      return (keys || []).length;
    },
    async clear(table) {
      data.get(table).clear();
    },
    async count(table) {
      return data.get(table).size;
    }
  };
}

// 统一的存储门面(供页面脚本与测试使用)
export async function createHistoryStore(options) {
  const opts = options || {};
  let backend;
  let mode = "memory";
  let degradedReason = null;
  if (opts.memory) {
    backend = memoryBackend();
  } else {
    try {
      const db = await openDB();
      backend = idbStore(db);
      mode = "indexeddb";
    } catch (error) {
      backend = memoryBackend();
      mode = "memory";
      // 关键:必须把"为什么退化"暴露出来。静默退化成空库会让上层以为"首次运行",
      // 进而建一个全新账户 —— 用户看起来就是"账户被重置"。
      degradedReason = (error && (error.message || error.name)) || "indexeddb_open_failed";
    }
  }

  const store = {
    mode,
    degraded: mode === "memory" && !opts.memory,
    degraded_reason: degradedReason,
    signals: {
      put: (r) => backend.put(SIGNAL_TABLE.name, r),
      putMany: (rs) => backend.putMany(SIGNAL_TABLE.name, rs),
      get: (id) => backend.get(SIGNAL_TABLE.name, id),
      all: (limit) => backend.all(SIGNAL_TABLE.name, limit),
      bySymbol: (symbol, limit) => backend.byIndex(SIGNAL_TABLE.name, "symbol", symbol, limit),
      bySource: (source, limit) => backend.byIndex(SIGNAL_TABLE.name, "source", source, limit),
      byCanonical: (canonicalId, limit) => backend.byIndex(SIGNAL_TABLE.name, "canonical_sample", canonicalId, limit),
      del: (id) => backend.del(SIGNAL_TABLE.name, id),
      delMany: (ids) => backend.delMany(SIGNAL_TABLE.name, ids),
      clear: () => backend.clear(SIGNAL_TABLE.name),
      count: () => backend.count(SIGNAL_TABLE.name)
    },
    outcomes: {
      put: (r) => backend.put(SIGNAL_OUTCOME_TABLE.name, r),
      putMany: (rs) => backend.putMany(SIGNAL_OUTCOME_TABLE.name, rs),
      get: (signalId) => backend.get(SIGNAL_OUTCOME_TABLE.name, signalId),
      all: (limit) => backend.all(SIGNAL_OUTCOME_TABLE.name, limit),
      del: (signalId) => backend.del(SIGNAL_OUTCOME_TABLE.name, signalId),
      clear: () => backend.clear(SIGNAL_OUTCOME_TABLE.name),
      count: () => backend.count(SIGNAL_OUTCOME_TABLE.name)
    },
    generic: {
      put: (table, record) => backend.put(table, record),
      putMany: (table, records) => backend.putMany(table, records),
      all: (table, limit) => backend.all(table, limit),
      get: (table, key) => backend.get(table, key),
      del: (table, key) => backend.del(table, key),
      delMany: (table, keys) => backend.delMany(table, keys),
      clear: (table) => backend.clear(table),
      count: (table) => backend.count(table)
    },
    async meta(key, value) {
      if (value === undefined) {
        const rec = await backend.get("system_settings", key);
        if (!rec) return null;
        try {
          return JSON.parse(rec.value);
        } catch (error) {
          return rec.value;
        }
      }
      await backend.put("system_settings", { key, value: JSON.stringify(value), updated_at: Date.now() });
      return value;
    },
    // 信号 + 结果 的连接视图(统计用)
    async joined(options) {
      const o = options || {};
      const signals = o.signalIds
        ? await Promise.all(o.signalIds.map((id) => backend.get(SIGNAL_TABLE.name, id)))
        : await backend.all(SIGNAL_TABLE.name, o.limit);
      const outcomes = await backend.all(SIGNAL_OUTCOME_TABLE.name);
      const map = new Map();
      for (const oc of outcomes) map.set(oc.signal_id, oc);
      return signals.filter(Boolean).map((signal) => ({ signal, outcome: map.get(signal.id) || null }));
    },
    async clearAll() {
      for (const table of ALL_TABLES) await backend.clear(table.name);
    }
  };
  return store;
}
