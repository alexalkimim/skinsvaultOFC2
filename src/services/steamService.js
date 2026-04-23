// steamService.js — COMPLETO (Todos os itens, incluindo recém saídos de trade lock)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');

const tradeLinkMemory = new Map();

// ---------------------------------------------------------
// EXTRAÇÃO DO STEAMID
// ---------------------------------------------------------
async function extractSteamID(input, apiKey) {
  const trimmed = input.trim();

  if (trimmed.includes('tradeoffer/new')) {
    logger.request(`Convertendo trade link via API...`);
    let id;

    try {
      const { data } = await axios.get('https://csinventoryapi.com/api/v2/steam/tradeurl', {
        timeout: 10000,
        params: { api_key: apiKey, url: trimmed },
      });
      if (data?.steamid64) id = data.steamid64;
    } catch {}

    if (!id) {
      const partner = new URL(trimmed).searchParams.get('partner');
      if (partner) id = (BigInt(partner) + BigInt('76561197960265728')).toString();
    }

    if (id) {
      logger.info(`Trade link → SteamID: ${id}`);
      tradeLinkMemory.set(id, trimmed);
      return id;
    }
  }

  if (trimmed.includes('steamcommunity.com')) {
    const segments = new URL(trimmed).pathname.split('/').filter(Boolean);
    if (segments[0] === 'profiles') return segments[1];
  }

  if (/^7656119\d{10}$/.test(trimmed)) return trimmed;

  throw new Error(`Não foi possível extrair SteamID de: "${trimmed}"`);
}

// ---------------------------------------------------------
// PARSER — inclui TODOS os itens marketáveis (mesmo não tradáveis)
// ---------------------------------------------------------
function parseInventoryResponse(data) {
  const descMap = {};
  for (const d of (data.descriptions || [])) {
    descMap[`${d.classid}_${d.instanceid || '0'}`] = d;
  }

  const items = [];
  let ignorados = 0;

  for (const asset of (data.assets || [])) {
    const key  = `${asset.classid}_${asset.instanceid || '0'}`;
    const desc = descMap[key];

    if (!desc || !desc.market_hash_name) {
      ignorados++;
      continue;
    }

    // CORREÇÃO: Itens recém saídos de trade lock podem ter tradable=0 na Steam pública,
    // mas marketable=1. Se usarmos o Trade Link, eles aparecem normalmente.
    // Mantemos a lógica de incluir se for marketável OU tradável.
    if (!desc.marketable && !desc.tradable) {
      ignorados++;
      continue;
    }

    const amount = parseInt(asset.amount, 10) || 1;
    for (let i = 0; i < amount; i++) {
      items.push({
        assetid:          asset.assetid,
        classid:          asset.classid,
        market_hash_name: desc.market_hash_name,
        name:             desc.name,
        tradable:         desc.tradable,
        marketable:       desc.marketable,
      });
    }
  }

  if (ignorados > 0) logger.warn(`${ignorados} itens ignorados (Medalhas, Moedas, etc).`);
  return items;
}

// ---------------------------------------------------------
// PAGINAÇÃO DA STEAM PÚBLICA
// ---------------------------------------------------------
async function fetchSteamPublicInventory(steamId) {
  logger.request(`Steam pública: buscando todas as páginas do inventário...`);

  let allAssets       = [];
  let allDescriptions = [];
  let lastAssetId     = undefined;
  let page            = 1;

  while (true) {
    const params = {
      l:      'english',
      count:  2000,
      _:      Date.now(),
    };
    if (lastAssetId) params.start_assetid = lastAssetId;

    try {
      const { data } = await axios.get(
        `https://steamcommunity.com/inventory/${steamId}/730/2`,
        { timeout: 20000, params }
      );

      if (!data?.assets) break;

      allAssets       = allAssets.concat(data.assets);
      allDescriptions = allDescriptions.concat(data.descriptions || []);

      logger.info(`  Página ${page}: +${data.assets.length} itens (total: ${allAssets.length})`);

      if (!data.more_items || data.more_items === 0) break;

      lastAssetId = data.last_assetid;
      page++;

      if (page > 20) { logger.warn('Limite de 20 páginas atingido.'); break; }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      logger.error(`Erro na página ${page}: ${err.message}`);
      break;
    }
  }

  return { assets: allAssets, descriptions: allDescriptions };
}

// ---------------------------------------------------------
// BUSCA DE INVENTÁRIO — 3 tentativas em cascata
// ---------------------------------------------------------
async function fetchInventory(steamId, apiKey) {
  const cacheKey = `inventory:${steamId}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Inventário ${steamId} (cache em memória)`); return cached; }

  const tradelink = tradeLinkMemory.get(steamId);
  let data;

  // TENTATIVA 1: API v2 via Trade Link (Business/Enterprise)
  // Esta é a ÚNICA forma de pegar itens que acabaram de sair do trade lock
  // e ainda não estão visíveis no inventário público da Steam.
  if (tradelink) {
    logger.request(`Tentativa 1: Inventário via Trade Link (API v2)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
        timeout: 20000,
        params: { api_key: apiKey, tradelink: encodeURIComponent(tradelink), appid: 730 },
      });
      // Verificamos se retornou assets. A API v2 é superior para itens em trade lock.
      if (res.data?.assets?.length > 0) {
        data = res.data;
        logger.success(`✅ Inventário via Trade Link: ${data.assets.length} assets`);
      }
    } catch (err) {
      logger.warn(`API v2 (Trade Link) falhou ou não autorizada. Tentando v1...`);
    }
  }

  // TENTATIVA 2: API v1 via SteamID
  if (!data) {
    logger.request(`Tentativa 2: Inventário via SteamID (API v1)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
        timeout: 20000,
        params: { api_key: apiKey, steamid64: steamId, appid: 730, contextid: 2 },
      });
      if (res.data?.assets?.length > 0) {
        data = res.data;
        logger.success(`✅ Inventário v1: ${data.assets.length} assets`);
      }
    } catch (err) {
      logger.warn(`API v1 falhou. Tentando Steam pública...`);
    }
  }

  // TENTATIVA 3: Steam pública com paginação completa
  if (!data) {
    logger.request(`Tentativa 3: Steam pública (com paginação completa)...`);
    data = await fetchSteamPublicInventory(steamId);
  }

  if (!data?.assets?.length) {
    throw new Error('Inventário vazio, privado ou todas as tentativas falharam.');
  }

  const items = parseInventoryResponse(data);
  logger.success(`${items.length} itens parseados`);

  // Cache em memória curto (1 min) para evitar spam, mas permitir atualizações rápidas
  cache.set(cacheKey, items, 1 * 60 * 1000);
  return items;
}

module.exports = { extractSteamID, fetchInventory };
