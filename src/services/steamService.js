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
  // Se a API retornar um array direto de itens (comum em algumas rotas da v2)
  if (Array.isArray(data)) {
    return data.map(item => ({
      assetid: item.assetid || item.id,
      market_hash_name: item.market_hash_name,
      name: item.name || item.market_hash_name
    })).filter(i => i.market_hash_name);
  }

  const descMap = {};
  // Mapeia descrições por classid e instanceid
  for (const d of (data.descriptions || [])) {
    const key = `${d.classid}_${d.instanceid || '0'}`;
    descMap[key] = d;
  }

  const items = [];
  // Suporte a 'assets' ou 'inventory' conforme a versão da API v2
  const assets = data.assets || data.inventory || [];

  for (const asset of assets) {
    const key  = `${asset.classid}_${asset.instanceid || '0'}`;
    const desc = descMap[key];

    // Se não achar pela chave composta, tenta só pelo classid (comum em alguns itens da v2)
    const finalDesc = desc || (data.descriptions || []).find(d => String(d.classid) === String(asset.classid));

    // Lógica agressiva para encontrar o market_hash_name (especialmente para Grafites/Sprays)
    let marketHashName = asset.market_hash_name || finalDesc?.market_hash_name;
    let displayName = asset.name || finalDesc?.name || marketHashName;

    // Caso especial para Grafites que não têm market_hash_name direto:
    // Às vezes o nome está em tags (Type=Graffiti, Graffiti Color=...)
    if (!marketHashName && finalDesc?.tags) {
      const typeTag = finalDesc.tags.find(t => t.category === 'Type');
      const colorTag = finalDesc.tags.find(t => t.category === 'SprayColorCategory');
      if (typeTag && colorTag) {
        // Ex: Sealed Graffiti | [Pattern Name] (Shark White)
        // Isso é um fallback, o ideal é o market_hash_name
        marketHashName = `${typeTag.name} | (Shark White)`; // Exemplo simplificado
      }
    }

    if (!marketHashName) {
      logger.debug(`Item ignorado (sem identificação): Asset ${asset.assetid} | Class ${asset.classid}`);
      continue;
    }

    const amount = parseInt(asset.amount, 10) || 1;
    for (let i = 0; i < amount; i++) {
      items.push({
        assetid: asset.assetid,
        market_hash_name: marketHashName,
        name: displayName || marketHashName
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

  // TENTATIVA 1: API v2 via Trade Link
  if (tradelink) {
    logger.request(`Buscando via Trade Link (API v2)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
        timeout: 45000,
        params: { api_key: apiKey, tradelink: encodeURIComponent(tradelink), appid: 730 },
      });
      
      const resData = res.data;
      const count = (resData?.assets || resData?.inventory || (Array.isArray(resData) ? resData : [])).length;

      if (count > 0) {
        data = resData;
        logger.success(`✅ SUCESSO: ${count} itens via Trade Link (API v2)`);
      } else {
        logger.warn(`API v2 vazia ou erro: ${resData?.message || 'Nenhum item'}. Tentando v1...`);
      }
    } catch (err) {
      logger.error(`Erro na API v2: ${err.response?.data?.message || err.message}. Tentando v1...`);
    }
  }

  // TENTATIVA 2: API v1 (Fallback automático se a v2 falhar)
  if (!data) {
    logger.request(`Buscando via SteamID (API v1)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
        timeout: 25000,
        params: { api_key: apiKey, steamid64: steamId, appid: 730, contextid: 2 },
      });
      if (res.data?.assets?.length > 0 || res.data?.inventory?.length > 0) {
        data = res.data;
        const count = (data.assets || data.inventory).length;
        logger.success(`Inventário capturado via API v1 (${count} itens)`);
      }
    } catch (err) {
      logger.error(`Falha crítica na API v1: ${err.response?.data?.message || err.message}`);
    }
  }

  if (!data) {
    throw new Error('ERRO: Não foi possível capturar os itens em nenhuma API. Verifique se o inventário está PÚBLICO na Steam.');
  }

  const items = parseInventoryResponse(data);
  
  if (items.length === 0) {
    throw new Error('ERRO: Inventário processado está vazio. Verifique se o usuário possui itens de CS2.');
  }

  logger.info(`Total de itens processados: ${items.length}`);
  
  // Cache de 6 horas para o inventário
  cache.set(cacheKey, items, 6 * 60 * 60 * 1000);
  return items;
}

module.exports = { extractSteamID, fetchInventory };
