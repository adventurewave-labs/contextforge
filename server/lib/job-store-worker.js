'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { createStore } = require('./store');

function runStoreWorker() {
  const store = createStore({ allowMemoryFallback: workerData.allowMemoryFallback });
  parentPort.on('message', async ({ id, operation, arg }) => {
    try {
      const result = await store[operation](arg);
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

function connect(thread, timeoutMs) {
  const pending = new Map();
  const state = { thread, error: null, exited: false, send };
  let nextId = 0;

  function fail(error) {
    if (state.error) return;
    state.error = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  thread.on('error', fail);
  thread.on('exit', (code) => {
    state.exited = true;
    fail(new Error('The job store worker exited with code ' + code));
  });
  thread.on('message', ({ id, result, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    if (error !== undefined) call.reject(new Error(error));
    else call.resolve(result);
  });

  function send(operation, arg) {
    return new Promise((resolve, reject) => {
      if (state.error) throw state.error;
      const id = nextId++;
      const timer = setTimeout(() => {
        fail(new Error('The job store worker did not reply in time'));
        thread.terminate().catch(() => { /* keep the failed connection until it exits */ });
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        thread.postMessage({ id, operation, arg });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return state;
}

function createJobStoreClient(spawn = (data) => new Worker(__filename, { workerData: data }), timeoutMs = 30_000) {
  let active;
  let closing;

  async function request(operation, arg) {
    if (closing) throw new Error('The job store client is closed');
    if (!active || active.exited) {
      active = connect(spawn({ allowMemoryFallback: !active }), timeoutMs);
    }
    return active.send(operation, arg);
  }

  function close() {
    if (!closing) {
      closing = (async () => {
        if (!active || active.exited) return;
        try {
          if (!active.error) await active.send('close');
        } finally {
          await active.thread.terminate();
        }
      })();
    }
    return closing;
  }

  return { request, close };
}

if (!isMainThread && require.main === module) runStoreWorker();

module.exports = { createJobStoreClient };
