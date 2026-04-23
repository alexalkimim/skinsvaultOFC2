// priceService.js — PRECISO (USD Direto -> BRL Ao Vivo + Spread)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

const SPREAD_PERCENT = Number(process.env.BRL_SPREAD_PERCENT) || 0;
let USD_TO_BRL = 5.00; // Fallback

async function fetchExchangeRate() {
  if (process.env.CUSTOM_USD_TO_BRL) {
    USD_TO_BRL = Number(process.env.CUSTOM_USD_TO_BRL);
    logger.success(`Câmbio (Manual .env): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    return;
  }

  try {
    // Puxando DÓLAR para REAL ao vivo (atualiza a cada 30 segundos)
    const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL', { timeout: 8000 });
    if (data?.USDBRL?.bid) {
      const baseRate = Number(data.USDBRL.bid);
      
      // Aplica a taxa da sua extensão (Spread) em cima do dólar comercial
      USD_TO_BRL = baseRate + (baseRate * (SPREAD_PERCENT / 100));
      
      if (SPREAD_PERCENT > 0) {
        logger.success(`Câmbio (Ao Vivo + ${SPREAD_PERCENT}% Spread): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
      } else {
        logger.success(`Câmbio (Ao Vivo Comercial): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
      }
    }
  } catch (err) {
    logger.warn(`Câmbio não atualizado. Usando último valor: R$ ${USD_TO_BRL.toFixed(4)}`);
  }
}

const toBRL = (usd) => (Number(usd) * USD_TO_BRL).toFixed(2);

async function fetchAllPrices(source, apiKey) {
  const cacheKey = `allprices:${source}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Preços ${source} (cache)`); return cached; }

  logger.request(`Buscando TODOS os preços: ${source}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    timeout: 60000,
    params: { api_key: apiKey, source, app_id: 730 },
  });

  const priceMap = new Map();
  for (const [name, info] of Object.entries(data)) {
    // A API fornece os centavos em Dólar (usd). Essa é a fonte mais pura.
    if (info?.sell_price_cents?.usd) {
      priceMap.set(name, info.sell_price_cents.usd / 100);
    } else {
      priceMap.set(name, 0);
    }
  }

  logger.success(`${source}: ${priceMap.size} itens carregados`);
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

  logger.info(`${items.length} itens → ${uniqueNames.length} únicos`);

  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  logger.success(`Banco: ${dbBatch.size} itens válidos encontrados`);

  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: buscando preços para ${needsAPI.length} itens não cacheados`);
    logger.divider();

    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    const toSave = [];
    for (const name of needsAPI) {
      const buff   = buffMap.get(name)   || 0;
      const youpin = youpinMap.get(name) || 0;
      if (buff > 0 || youpin > 0) {
        toSave.push({ name, buff, youpin });
      }
    }

    if (toSave.length > 0) {
      await Promise.all(toSave.map(({ name, buff, youpin }) =>
        db.savePriceToDB(name, { buff, youpin })
      ));
      logger.success(`${toSave.length} preços salvos no banco`);
    }
  } else {
    logger.info('Todos os preços vieram do banco — 0 requests à API!');
    logger.divider();
  }

  const results   = [];
  let totalBuff   = 0;
  let totalYouPin = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);

    let buff   = 0;
    let youpin = 0;

    if (dbBatch.has(name)) {
      buff   = dbBatch.get(name).buff;
      youpin = dbBatch.get(name).youpin;
    } else {
      buff   = buffMap.get(name)   || 0;
      youpin = youpinMap.get(name) || 0;
    }

    // Filtro Anti-Troll (Iguala discrepâncias absurdas)
    if (buff > 0 && (youpin > buff * 2 || youpin === 0)) youpin = buff; 
    else if (youpin > 0 && (buff > youpin * 2 || buff === 0)) buff = youpin;

    const buffTotal   = buff   * quantity;
    const youpinTotal = youpin * quantity;
    totalBuff   += buffTotal;
    totalYouPin += youpinTotal;

    results.push({
      name:      item.name || name,
      quantity,
      buffBRL:   toBRL(buffTotal),
      youpinBRL: toBRL(youpinTotal),
      buffUSD:   buffTotal.toFixed(2),
      youpinUSD: youpinTotal.toFixed(2),
    });
  }

  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL:   toBRL(totalBuff),
    totalYouPinBRL: toBRL(totalYouPin),
    usdToBrl:       USD_TO_BRL,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };