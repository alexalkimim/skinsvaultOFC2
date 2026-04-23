// steamService.js — OTIMIZADO (Bypass de Cache da Steam via Trade Link)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');

// Memória secreta para guardar o Trade Link sem precisar alterar o index.js
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
    
    // Fallback local se a API de conversão falhar
    if (!id) {
      const partner = new URL(trimmed).searchParams.get('partner');
      if (partner) id = (BigInt(partner) + BigInt('76561197960265728')).toString();
    }

    if (id) {
      logger.info(`Trade link → SteamID: ${id}`);
      // Salva o link original na memória para usarmos na quebra de cache depois!
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
// PARSER INTELIGENTE
// ---------------------------------------------------------
function parseInventoryResponse(data) {
  const descMap = {};
  for (const d of (data.descriptions || [])) {
    const cId = d.classid || '';
    const iId = d.instanceid || '0';
    descMap[`${cId}_${iId}`] = d;
  }

  const items = [];
  let ignorados = 0;

  for (const asset of (data.assets || [])) {
    const cId = asset.classid || '';
    const iId = asset.instanceid || '0';
    const desc = descMap[`${cId}_${iId}`];
    
    if (!desc || !desc.market_hash_name) {
      ignorados++;
      continue;
    }

    const amount = parseInt(asset.amount, 10) || 1;

    for (let i = 0; i < amount; i++) {
      items.push({
        assetid:          asset.assetid,
        classid:          cId,
        market_hash_name: desc.market_hash_name,
        name:             desc.name,
        tradable:         desc.tradable,
        marketable:       desc.marketable,
      });
    }
  }

  if (ignorados > 0) {
    logger.warn(`${ignorados} itens de base ignorados (Medalhas, Moedas, etc).`);
  }

  return items;
}

// ---------------------------------------------------------
// BUSCA DE INVENTÁRIO (Com Quebra de Cache Automática)
// ---------------------------------------------------------
async function fetchInventory(steamId, apiKey) {
  const cacheKey = `inventory:${steamId}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Inventário ${steamId} (cache local)`); return cached; }

  const tradelink = tradeLinkMemory.get(steamId);
  let data;

  // 1. TENTATIVA VIP (V2): Quebra o cache da Steam Pública usando o Trade Link
  if (tradelink) {
    logger.request(`Buscando inventário AO VIVO via Trade Link (Bypass de Cache)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v2/inventory', {
        timeout: 15000,
        // É obrigatório enviar a URL encodada conforme a documentação
        params: { api_key: apiKey, tradelink: encodeURI(tradelink), appid: 730 }
      });
      if (res.data && res.data.assets) {
        data = res.data;
        logger.success(`Inventário ao vivo carregado com sucesso!`);
      }
    } catch (err) {
      logger.warn(`API VIP (V2) indisponível ou falhou. Tentando V1...`);
    }
  }

  // 2. TENTATIVA V1 (Com SteamID - Sujeita ao cache da Steam)
  if (!data) {
    logger.request(`Buscando inventário via SteamID (API V1)...`);
    try {
      const res = await axios.get('https://csinventoryapi.com/api/v1/inventory', {
        timeout: 15000,
        // Adicionamos um timestamp no final para forçar os servidores
        params: { api_key: apiKey, steamid64: steamId, appid: 730, contextid: 2, t: Date.now() },
      });
      if (res.data && res.data.success === 1) data = res.data;
    } catch (err) {}
  }

  // 3. FALLBACK EXTREMO: STEAM PÚBLICA DIRETA
  if (!data) {
    logger.request(`APIs falharam. Recorrendo aos servidores públicos da Steam...`);
    const res = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2`, {
      timeout: 15000,
      params: { l: 'english', count: 2000, _: Date.now() }
    });
    data = res.data;
  }

  if (!data || !data.assets) {
    throw new Error('Inventário vazio, privado ou servidores da Steam fora do ar.');
  }

  const items = parseInventoryResponse(data);
  // Salvamos em cache por apenas 1 minuto para manter sempre atualizado
  cache.set(cacheKey, items, 1 * 60 * 1000); 
  return items;
}

module.exports = { extractSteamID, fetchInventory };