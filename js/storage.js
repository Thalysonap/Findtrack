(function (root) {
  'use strict';

  const DB_NAME = 'fintrack_db';
  const DB_VERSION = 1;
  const PREFIX = 'fintrack_';
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in root)) return reject(new Error('IndexedDB indisponível'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Falha ao abrir IndexedDB'));
    });
  }

  function idbGet(key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Falha ao gravar IndexedDB'));
      transaction.onabort = () => reject(transaction.error || new Error('Gravação cancelada'));
    });
  }

  function localGet(key) {
    try {
      const value = localStorage.getItem(PREFIX + key);
      return value == null ? undefined : JSON.parse(value);
    } catch { return undefined; }
  }

  function localSet(key, value) {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  }

  async function init() {
    try { db = await openDB(); } catch { db = null; }
    return !!db;
  }

  async function get(key) {
    if (db) {
      try {
        const value = await idbGet(key);
        if (value !== undefined) return value;
      } catch {}
    }
    return localGet(key);
  }

  async function set(key, value) {
    let localError = null;
    try { localSet(key, value); } catch (error) { localError = error; }
    if (db) {
      try { await idbSet(key, value); return; } catch (error) {
        if (localError) throw error;
      }
    }
    if (localError) throw localError;
  }

  root.FintrackStorage = { init, get, set };
})(typeof globalThis !== 'undefined' ? globalThis : this);
