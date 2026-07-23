(() => {
  'use strict';

  const STORAGE_KEY = 'mpse:image-effect-records:v2';
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

  function encodePrivate(value) {
    const text = String(value || '');
    if (!text) return '';
    return btoa(encodeURIComponent(text));
  }

  function decodePrivate(value) {
    if (!value) return '';
    try {
      return decodeURIComponent(atob(String(value)));
    } catch (_) {
      return '';
    }
  }

  function cleanStoredAsset(asset) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return {};
    return {
      sourceUrl: typeof asset.sourceUrl === 'string' ? asset.sourceUrl : '',
      bakedUrl: typeof asset.bakedUrl === 'string' ? asset.bakedUrl : '',
      sourceAttributes: cleanData(asset.sourceAttributes),
      width: Math.max(0, Math.round(Number(asset.width) || 0)),
      height: Math.max(0, Math.round(Number(asset.height) || 0)),
      recipeKey: typeof asset.recipeKey === 'string' ? asset.recipeKey : ''
    };
  }

  function serializeSourceAttributes(attributes) {
    const cleaned = cleanData(attributes);
    return Object.fromEntries(Object.entries(cleaned).map(([name, value]) => [
      name,
      ['src', 'data-src', 'data-backsrc', 'data-croporisrc'].includes(name) ? encodePrivate(value) : value
    ]));
  }

  function deserializeSourceAttributes(attributes) {
    const cleaned = cleanData(attributes);
    return Object.fromEntries(Object.entries(cleaned).map(([name, value]) => [
      name,
      ['src', 'data-src', 'data-backsrc', 'data-croporisrc'].includes(name) ? decodePrivate(value) : value
    ]));
  }

  function serializeAsset(asset) {
    const cleaned = cleanStoredAsset(asset);
    return {
      ...cleaned,
      sourceUrl: encodePrivate(cleaned.sourceUrl),
      bakedUrl: encodePrivate(cleaned.bakedUrl),
      sourceAttributes: serializeSourceAttributes(cleaned.sourceAttributes)
    };
  }

  function deserializeAsset(asset) {
    const cleaned = cleanStoredAsset(asset);
    return {
      ...cleaned,
      sourceUrl: decodePrivate(cleaned.sourceUrl),
      bakedUrl: decodePrivate(cleaned.bakedUrl),
      sourceAttributes: deserializeSourceAttributes(cleaned.sourceAttributes)
    };
  }

  function hasAsset(asset) {
    return Boolean(asset && (asset.sourceUrl || asset.bakedUrl || Object.keys(asset.sourceAttributes || {}).length));
  }

  function create(options = {}) {
    let storage = options.storage || null;
    if (!storage) {
      try {
        storage = globalThis.localStorage;
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
            asset: cleanStoredAsset(record.asset),
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
        // Memory records keep the current editing session usable when durable storage is unavailable.
      }
    }

    function matchingRecords(identity) {
      const aliases = new Set(identityAliases(identity));
      return records.filter((record) => record.aliases.some((alias) => aliases.has(alias)));
    }

    function find(identity) {
      const record = matchingRecords(identity)[0];
      return record ? {
        editId: record.editId,
        data: { ...record.data },
        hostData: { ...record.hostData },
        asset: deserializeAsset(record.asset)
      } : null;
    }

    function upsert(identity, data, hostData, asset) {
      const aliases = identityAliases(identity);
      if (!aliases.length) return false;
      const matches = matchingRecords(identity);
      const mergedAliases = Array.from(new Set([
        ...aliases,
        ...matches.flatMap((record) => record.aliases)
      ]));
      const cleaned = cleanData(data);
      const cleanedHostData = cleanData(hostData);
      const storedAsset = asset === undefined
        ? (matches[0]?.asset || {})
        : serializeAsset(asset);
      const matchSet = new Set(matches);
      records = records.filter((record) => !matchSet.has(record));
      if (Object.keys(cleaned).length || Object.keys(cleanedHostData).length || hasAsset(storedAsset)) {
        records.unshift({
          aliases: mergedAliases,
          editId: typeof identity.editId === 'string' ? identity.editId : (matches[0]?.editId || ''),
          data: cleaned,
          hostData: cleanedHostData,
          asset: storedAsset,
          updatedAt: Date.now()
        });
      }
      records = records.slice(0, limit);
      persist();
      return true;
    }

    function remember(identity, data, hostData = {}) {
      return upsert(identity, data, hostData, undefined);
    }

    function rememberAsset(identity, asset) {
      const current = find(identity);
      return upsert(identity, current?.data || {}, current?.hostData || {}, asset);
    }

    function forget(identity) {
      const matches = new Set(matchingRecords(identity));
      if (!matches.size) return false;
      records = records.filter((record) => !matches.has(record));
      persist();
      return true;
    }

    return Object.freeze({ find, remember, rememberAsset, forget });
  }

  globalThis.__MPSE_IMAGE_EFFECT_RECORDS__ = Object.freeze({ create, identityAliases });
})();
