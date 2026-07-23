(() => {
  'use strict';

  const STORAGE_KEY = 'mpse:image-effect-records:v1';
  const DEFAULT_LIMIT = 120;

  function compactHash(value) {
    const text = String(value || '');
    let forward = 2166136261;
    let backward = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      forward ^= text.charCodeAt(index);
      forward = Math.imul(forward, 16777619);
      backward ^= text.charCodeAt(text.length - index - 1);
      backward = Math.imul(backward, 16777619);
    }
    return `${(forward >>> 0).toString(36)}${(backward >>> 0).toString(36)}`;
  }

  function identityAliases(identity) {
    if (!identity) return [];
    const scope = `${identity.pageKey || 'page'}|${identity.scopeKey || 'article'}`;
    const source = identity.fileId || identity.dataSrc || identity.src || identity.dataBackSrc || identity.dataCropSrc || '';
    const position = Number.isFinite(identity.index) ? identity.index : -1;
    const fallback = [scope, position, source, identity.w || '', identity.ratio || '', identity.alt || ''].join('|');
    const aliases = [];
    if (identity.editId) aliases.push(`id:${compactHash(`${scope}|${identity.editId}`)}`);
    if (source || identity.w || identity.ratio || identity.alt) aliases.push(`image:${compactHash(fallback)}`);
    return Array.from(new Set(aliases));
  }

  function cleanData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data)
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string'));
  }

  function create(options = {}) {
    let storage = options.storage || null;
    if (!storage) {
      try {
        storage = globalThis.sessionStorage;
      } catch (_) {
        storage = null;
      }
    }
    const limit = Math.max(10, Number(options.limit) || DEFAULT_LIMIT);
    let records = [];

    try {
      const parsed = JSON.parse(storage && storage.getItem ? storage.getItem(STORAGE_KEY) || '[]' : '[]');
      if (Array.isArray(parsed)) {
        records = parsed
          .filter((record) => record && Array.isArray(record.aliases) && record.aliases.length)
          .map((record) => ({
            aliases: record.aliases.filter((alias) => typeof alias === 'string'),
            editId: typeof record.editId === 'string' ? record.editId : '',
            data: cleanData(record.data),
            hostData: cleanData(record.hostData),
            updatedAt: Number(record.updatedAt) || 0
          }))
          .slice(0, limit);
      }
    } catch (_) {
      records = [];
    }

    function persist() {
      try {
        if (storage && storage.setItem) storage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, limit)));
      } catch (_) {
        // In-memory records still protect the active editing session when storage is unavailable.
      }
    }

    function find(identity) {
      const aliases = new Set(identityAliases(identity));
      const record = records.find((candidate) => candidate.aliases.some((alias) => aliases.has(alias)));
      return record ? {
        editId: record.editId,
        data: { ...record.data },
        hostData: { ...record.hostData }
      } : null;
    }

    function remember(identity, data, hostData = {}) {
      const aliases = identityAliases(identity);
      if (!aliases.length) return false;
      const aliasSet = new Set(aliases);
      records = records.filter((record) => !record.aliases.some((alias) => aliasSet.has(alias)));
      const cleaned = cleanData(data);
      const cleanedHostData = cleanData(hostData);
      if (Object.keys(cleaned).length || Object.keys(cleanedHostData).length) {
        records.unshift({
          aliases,
          editId: typeof identity.editId === 'string' ? identity.editId : '',
          data: cleaned,
          hostData: cleanedHostData,
          updatedAt: Date.now()
        });
      }
      records = records.slice(0, limit);
      persist();
      return true;
    }

    return Object.freeze({ find, remember });
  }

  globalThis.__MPSE_IMAGE_EFFECT_RECORDS__ = Object.freeze({ create, identityAliases });
})();
