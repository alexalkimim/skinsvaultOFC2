// steamService.js — LEITOR LIMPO E PRECISO
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');

const tradeLinkMemory = new Map();

async function extractSteamID(input, apiKey) {
  const trimmed = input.trim();

  if (trimmed.includes('tradeoffer/new')) {
    logger.request(`Processando Trade Link...`);
    let id;

    try {
      const { data } = await axios.get('https://csinventoryapi.com/api/v2/steam/tradeurl', {
        timeout: 10000,
        params: { api_key: apiKey, url: trimmed },
      });
      if (data?.steamid64) id = data.steamid64;
    } catch (err) {
      logger.debug(`Erro API TradeURL: ${err.message}`);
    }

    if (!id) {
      try {
        const partner = new URL(trimmed).searchParams.get('partner');
        if (partner) id = (BigInt(partner) + BigInt('76561197960265728')).toString();
      } catch (err) {}
    }

    if (id) {
      tradeLinkMemory.set(id, trimmed);
      return id;
    }
  }

  if (trimmed.includes('steamcommunity.com')) {
    const segments = new URL(trimmed).pathname.split('/').filter(Boolean);
    if (segments[0] === 'profiles') return segments[1];
  }

  if (/^7656119\d{10}$/.test(trimmed)) return trimmed;
  throw new Error(`Não foi possível identificar o SteamID.`);
}

function parseInventoryResponse(data) {
  const rawItems = Array.isArray(data) ? data : (data.assets || data.inventory || data.data || []);
  
  const descMap = {};
  for (const d of (data.descriptions || [])) {
    const key = `${d.classid}_${d.instanceid || '0'}`;
    descMap[key] = d;
  }

  const items = [];
  for (const asset of rawItems) {
    let marketHashName = asset.market_hash_name;
    let displayName = asset.name || asset.market_hash_name;

    if (!marketHashName) {
      const key = `${asset.classid}_${asset.instanceid || '0'}`;
      const desc = descMap[key] || (data.descriptions || []).find(d => String(d.classid) === String(asset.classid));
      marketHashName = desc?.market_hash_name;
      displayName = desc?.name || marketHashName;
    }

    // Se o item não tiver nome válido, ignoramos sem inventar nomes falsos!
    if (!marketHashName) continue;

    const amount = parseInt(asset.amount, 10) || 1;
    for (let i = 0; i < amount; i++) {
      items.push({
        assetid: asset.assetid || asset.id,
        market_hash_name: marketHashName,
        name: displayName
      });
    }
  }
  return items;
}

async function fetchInventory(steamId, apiKey) {
  const cacheKey = `inventory:${steamId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  const tradelink = tradeLinkMemory.get(steamId);
  let data;

  if (tradelink) {
    logger.request(`Buscando via Trade Link (API v2)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
        timeout: 45000,
        params: { api_key: apiKey, url: tradelink, tradelink: tradelink, appid: 730 },
      });
      const resData = res.data;
      const itemsFound = resData?.assets || resData?.inventory || resData?.data || (Array.isArray(resData) ? resData : []);
      if (itemsFound && itemsFound.length > 0) {
        data = resData;
        logger.success(`✅ SUCESSO: ${itemsFound.length} itens via Trade Link (API v2)`);
      }
    } catch (err) {}
  }

  if (!data) {
    logger.request(`Buscando via SteamID (API v1)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
        timeout: 25000,
        params: { api_key: apiKey, steamid64: steamId, appid: 730, contextid: 2, t: Date.now() },
      });
      if (res.data?.assets?.length > 0 || res.data?.inventory?.length > 0) data = res.data;
    } catch (err) {}
  }

  if (!data) throw new Error('ERRO: Não foi possível capturar os itens em nenhuma API.');

  const items = parseInventoryResponse(data);
  if (items.length === 0) throw new Error('ERRO: Inventário processado está vazio.');

  logger.info(`Total de itens processados: ${items.length}`);
  cache.set(cacheKey, items, 1 * 60 * 1000);
  return items;
}

module.exports = { extractSteamID, fetchInventory };