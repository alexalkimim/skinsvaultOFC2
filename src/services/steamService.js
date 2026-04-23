// steamService.js — Extrai SteamID e busca inventário
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');

// ---------------------------------------------------------
// EXTRAÇÃO DO STEAMID
// Usa o endpoint oficial da CSInventoryAPI /api/v2/steam/tradeurl
// ---------------------------------------------------------

async function extractSteamID(input, apiKey) {
  const trimmed = input.trim();

  // Trade link → usa endpoint da API (mais confiável)
  if (trimmed.includes('tradeoffer/new')) {
    logger.request(`Convertendo trade link via API...`);
    try {
      const { data } = await axios.get('https://csinventoryapi.com/api/v2/steam/tradeurl', {
        timeout: 10000,
        params: { api_key: apiKey, url: trimmed },
      });
      if (data?.steamid64) {
        logger.info(`Trade link → SteamID: ${data.steamid64}`);
        return data.steamid64;
      }
    } catch {
      // Fallback: cálculo local
    }
    // Fallback local se a API falhar
    const partner = new URL(trimmed).searchParams.get('partner');
    if (partner) {
      const id = (BigInt(partner) + BigInt('76561197960265728')).toString();
      logger.info(`Trade link (local) → SteamID: ${id}`);
      return id;
    }
  }

  // Link de perfil/inventário
  if (trimmed.includes('steamcommunity.com')) {
    const segments = new URL(trimmed).pathname.split('/').filter(Boolean);
    if (segments[0] === 'profiles') {
      logger.info(`Perfil → SteamID: ${segments[1]}`);
      return segments[1];
    }
  }

  // SteamID64 direto
  if (/^7656119\d{10}$/.test(trimmed)) {
    logger.info(`SteamID direto: ${trimmed}`);
    return trimmed;
  }

  throw new Error(`Não foi possível extrair SteamID de: "${trimmed}"`);
}

// ---------------------------------------------------------
// BUSCA DE INVENTÁRIO — /api/v1/inventory
// ---------------------------------------------------------

function parseInventoryResponse(data) {
  const descMap = {};
  for (const d of (data.descriptions || [])) {
    descMap[`${d.classid}_${d.instanceid}`] = d;
  }
  const items = [];
  for (const asset of (data.assets || [])) {
    const desc = descMap[`${asset.classid}_${asset.instanceid}`];
    if (!desc || desc.tradable !== 1) continue;
    items.push({
      assetid:          asset.assetid,
      classid:          asset.classid,
      market_hash_name: desc.market_hash_name,
      name:             desc.name,
      tradable:         desc.tradable,
      marketable:       desc.marketable,
    });
  }
  return items;
}

async function fetchInventory(steamId, apiKey) {
  const cacheKey = `inventory:${steamId}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Inventário ${steamId} (${cached.length} itens)`); return cached; }

  logger.request(`Buscando inventário: ${steamId}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
    timeout: 30000,
    params: { api_key: apiKey, steamid64: steamId, appid: 730, contextid: 2 },
  });

  if (data.success !== 1) throw new Error(`API retornou: ${JSON.stringify(data)}`);

  const items = parseInventoryResponse(data);
  cache.set(cacheKey, items, 2 * 60 * 1000);
  return items;
}

module.exports = { extractSteamID, fetchInventory };