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
    } catch {}

    if (!id) {
      try {
        const partner = new URL(trimmed).searchParams.get('partner');
        if (partner) id = (BigInt(partner) + BigInt('76561197960265728')).toString();
      } catch {}
    }

    if (id) {
      tradeLinkMemory.set(id, trimmed);
      return id;
    }
  }

  if (/^7656119\d{10}$/.test(trimmed)) return trimmed;

  throw new Error(`Não foi possível identificar o SteamID.`);
}

function parseInventoryResponse(data) {
  const items = [];

  const assets = data.assets || [];

  for (const asset of assets) {
    const amount = parseInt(asset.amount, 10) || 1;

    for (let i = 0; i < amount; i++) {
      items.push({
        assetid: asset.assetid,
        market_hash_name: asset.market_hash_name || asset.name,
        name: asset.name || asset.market_hash_name || 'Unknown Item'
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

  if (!tradelink) {
    throw new Error('TradeLink não encontrado.');
  }

  logger.request(`Buscando via Trade Link (API v2)...`);

  try {
    const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
      timeout: 40000,
      params: {
        api_key: apiKey,
        tradelink: tradelink,
        appid: 730,
        contextid: 2
      },
    });

    const raw = res.data;

    console.log("DEBUG RAW:", JSON.stringify(raw, null, 2));

    if (!raw?.assets || raw.assets.length === 0) {
      throw new Error('API retornou sem assets.');
    }

    logger.success(`✅ ${raw.assets.length} assets recebidos`);

    const items = parseInventoryResponse(raw);

    logger.info(`Total real de itens: ${items.length}`);

    cache.set(cacheKey, items, 6 * 60 * 60 * 1000);

    return items;

  } catch (err) {
    logger.error(`Erro API v2: ${err.message}`);
    throw err;
  }
}

module.exports = { extractSteamID, fetchInventory };