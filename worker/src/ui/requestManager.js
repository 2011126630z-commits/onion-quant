// ui/requestManager.js · 防旧请求覆盖新状态(V14.1)
// 每个"逻辑视图"维护一个 generation + AbortController:
//   begin(key) → { key, generation, signal, isCurrent() }
//   只有 isCurrent() 为真时才允许写 UI;旧 generation 一律丢弃
//   leave(key) → 取消该视图在途请求(不影响其它视图/后台引擎)
export function createRequestManager(options) {
  const opts = options || {};
  const controllers = new Map(); // key -> { controller, generation }
  const state = { generations: Object.create(null), aborted: 0, discarded: 0, started: 0 };

  function begin(key) {
    const prev = controllers.get(key);
    if (prev && prev.controller) {
      try { prev.controller.abort(); state.aborted += 1; } catch (error) { /* ignore */ }
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const generation = (state.generations[key] || 0) + 1;
    state.generations[key] = generation;
    controllers.set(key, { controller, generation });
    state.started += 1;
    return {
      key,
      generation,
      signal: controller ? controller.signal : undefined,
      isCurrent: () => state.generations[key] === generation,
      commit: (fn) => {
        if (state.generations[key] !== generation) { state.discarded += 1; return false; }
        fn();
        return true;
      }
    };
  }

  function leave(key) {
    const entry = controllers.get(key);
    if (entry && entry.controller) {
      try { entry.controller.abort(); state.aborted += 1; } catch (error) { /* ignore */ }
    }
    // 提高 generation:任何尚未返回的旧响应都会被 isCurrent() 判为过期
    state.generations[key] = (state.generations[key] || 0) + 1;
    controllers.delete(key);
  }

  function leaveAll(exceptKeys) {
    const keep = new Set(exceptKeys || []);
    for (const key of [...controllers.keys()]) {
      if (!keep.has(key)) leave(key);
    }
  }

  function stats() {
    return { ...state, active: controllers.size };
  }

  return { begin, leave, leaveAll, stats, isCurrent: (key, generation) => state.generations[key] === generation };
}
