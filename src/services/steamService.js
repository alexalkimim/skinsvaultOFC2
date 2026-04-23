// steamService.js — FOCO TOTAL NO TRADE LINK (API V2)
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
  const descMap = {};

  for (const d of (data.descriptions || [])) {
    const key = `${d.classid}_${d.instanceid || '0'}`;
    descMap[key] = d;
  }

  const items = [];
  const assets = data.assets || [];

  for (const asset of assets) {
    const key  = `${asset.classid}_${asset.instanceid || '0'}`;
    const desc = descMap[key];

    const finalDesc =
      desc ||
      (data.descriptions || []).find(d => String(d.classid) === String(asset.classid));

    if (!finalDesc || !finalDesc.market_hash_name) {
      if (asset.market_hash_name) {
        const amount = parseInt(asset.amount, 10) || 1;
        for (let i = 0; i < amount; i++) {
          items.push({
            assetid: asset.assetid,
            market_hash_name: asset.market_hash_name,
            name: asset.name || asset.market_hash_name
          });
        }
      } else {
        logger.debug(`Asset sem descrição: ${asset.classid}`);
      }
      continue;
    }

    const amount = parseInt(asset.amount, 10) || 1;
    for (let i = 0; i < amount; i++) {
      items.push({
        assetid: asset.assetid,
        market_hash_name: finalDesc.market_hash_name,
        name: finalDesc.name || finalDesc.market_hash_name
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

  // 🔥 TENTATIVA 1: API v2 via Trade Link
  if (tradelink) {
    logger.request(`Buscando via Trade Link (API v2)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
        timeout: 40000,
        params: {
          api_key: apiKey,
          tradelink: tradelink, // ✅ CORRIGIDO (sem encode)
          appid: 730,
          contextid: 2 // ✅ importante
        },
      });

      if (res.data?.assets?.length > 0) {
        data = res.data;
        logger.success(`✅ SUCESSO: ${data.assets.length} assets capturados via Trade Link`);
      } else {
        logger.warn(`API v2 retornou vazio`);
      }
    } catch (err) {
      logger.error(`Erro API v2: ${err.response?.data?.message || err.message}`);
    }
  }

  // fallback v1
  if (!data && !tradelink) {
    logger.request(`Buscando via SteamID (API v1)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
        timeout: 20000,
        params: {
          api_key: apiKey,
          steamid64: steamId,
          appid: 730,
          contextid: 2
        },
      });

      if (res.data?.assets?.length > 0) {
        data = res.data;
        logger.success(`Inventário capturado via API v1`);
      }
    } catch (err) {
      logger.error(`Erro API v1: ${err.message}`);
    }
  }

  if (!data?.assets?.length) {
    throw new Error('Não foi possível capturar os itens.');
  }

  const items = parseInventoryResponse(data);

  logger.info(`Total real de itens: ${items.length}`);

  cache.set(cacheKey, items, 6 * 60 * 60 * 1000);
  return items;
}

module.exports = { extractSteamID, fetchInventory };