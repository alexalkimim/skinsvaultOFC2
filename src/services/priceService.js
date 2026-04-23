// priceService.js — PRECISÃO DE MERCADO BRASILEIRO (SALDO BUFF)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

// Fator de descompressão da API (reverte o Dólar inflacionado para a raiz em Yuan)
const BUFF_INTERNAL_USD_TO_CNY = 6.445; 

// Cotação padrão do Saldo Buff no Brasil (Ajustável via .env)
let BUFF_BALANCE_RATE = 0.7286; 

async function fetchExchangeRate() {
  if (process.env.BUFF_BALANCE_RATE) {
    BUFF_BALANCE_RATE = Number(process.env.BUFF_BALANCE_RATE);
    logger.success(`Câmbio (Saldo Buff .env): 1 CNY = R$ ${BUFF_BALANCE_RATE.toFixed(4)}`);
  } else {
    logger.success(`Câmbio (Saldo Buff Calibrado): 1 CNY = R$ ${BUFF_BALANCE_RATE.toFixed(4)}`);
  }
}

// A MÁGICA: Transforma o USD da API no BRL verdadeiro do mercado de skins
function usdToRealBRL(fakeUsd) {
  const trueCNY = Number(fakeUsd) * BUFF_INTERNAL_USD_TO_CNY;
  return (trueCNY * BUFF_BALANCE_RATE).toFixed(2);
}

async function fetchAllPrices(source, apiKey) {
  const cacheKey = `allprices_usd:${source}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Preços ${source} (cache)`); return cached; }

  logger.request(`Buscando TODOS os preços: ${source}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    timeout: 60000,
    params: { api_key: apiKey, source, app_id: 730 },
  });

  const pricesObj = data.data || data.items || data;
  const priceMap = new Map();

  for (const [name, info] of Object.entries(pricesObj)) {
    if (name === 'success') continue;

    let priceUSD = 0;
    if (info?.sell_price_cents?.usd) {
      priceUSD = Number(info.sell_price_cents.usd) / 100;
    } else if (info?.sell_price) {
      priceUSD = Number(info.sell_price);
    }
    priceMap.set(name, priceUSD);
  }

  logger.success(`${source}: ${priceMap.size} preços carregados`);
  cache.set(cacheKey, priceMap, 15 * 60 * 1000);
  return priceMap;
}

function deduplicateItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const name = item.market_hash_name;
    if (!name) continue;
    if (grouped.has(name)) grouped.get(name).quantity++;
    else grouped.set(name, { item, quantity: 1 });
  }
  return grouped;
}

async function processInventoryPrices(items, apiKey) {
  await fetchExchangeRate();

  const grouped     = deduplicateItems(items);
  const uniqueNames = [...grouped.keys()];

  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: Buscando preços para ${needsAPI.length} itens...`);
    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    const toSave = [];
    for (const name of needsAPI) {
      const buff   = buffMap.get(name)   || 0;
      const youpin = youpinMap.get(name) || 0;
      if (buff > 0 || youpin > 0) toSave.push({ name, buff, youpin });
    }

    if (toSave.length > 0) {
      await Promise.all(toSave.map(({ name, buff, youpin }) =>
        db.savePriceToDB(name, { buff, youpin })
      ));
    }
  }

  const results   = [];
  let totalBuffUSD   = 0;
  let totalYouPinUSD = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);

    let buffUSD   = dbBatch.has(name) ? dbBatch.get(name).buff : (buffMap.get(name) || 0);
    let youpinUSD = dbBatch.has(name) ? dbBatch.get(name).youpin : (youpinMap.get(name) || 0);

    if (buffUSD > 0 && (youpinUSD > buffUSD * 2 || youpinUSD === 0)) youpinUSD = buffUSD; 
    else if (youpinUSD > 0 && (buffUSD > youpinUSD * 2 || buffUSD === 0)) buffUSD = youpinUSD;

    const buffTotalUSD   = buffUSD   * quantity;
    const youpinTotalUSD = youpinUSD * quantity;
    
    totalBuffUSD   += buffTotalUSD;
    totalYouPinUSD += youpinTotalUSD;

    results.push({
      name:      item.name || name,
      quantity,
      buffBRL:   usdToRealBRL(buffTotalUSD),
      youpinBRL: usdToRealBRL(youpinTotalUSD),
      buffUSD:   buffTotalUSD.toFixed(2),
      youpinUSD: youpinTotalUSD.toFixed(2),
    });
  }

  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL:   usdToRealBRL(totalBuffUSD),
    totalYouPinBRL: usdToRealBRL(totalYouPinUSD),
    displayRate:    `Mercado Real (Saldo Buff) → 1 CNY = R$ ${BUFF_BALANCE_RATE.toFixed(4)}`,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };