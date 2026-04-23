// priceService.js — PRECISÃO MÁXIMA
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

// Taxas de câmbio (Fallbacks caso a API de câmbio falhe)
let USD_TO_BRL = 6.15; 

async function fetchExchangeRate() {
  if (process.env.CUSTOM_USD_TO_BRL) {
    USD_TO_BRL = Number(process.env.CUSTOM_USD_TO_BRL);
    logger.success(`Câmbio (Manual .env): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    return;
  }

  try {
    const { data } = await axios.get(
      'https://economia.awesomeapi.com.br/last/USD-BRL',
      { timeout: 8000 }
    );

    if (data?.USDBRL?.bid) {
      USD_TO_BRL = Number(data.USDBRL.bid);
      logger.success(`Câmbio ao vivo → 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    }
  } catch {
    logger.warn(`Câmbio não atualizado. Usando fallback: USD=R$ ${USD_TO_BRL}`);
  }
}

/**
 * Converte o valor retornado pela API (em USD cents) para BRL.
 */
function toBRL(usdValue) {
  const amount = Number(usdValue);
  if (!amount || amount === 0) return 0;
  // Multiplicação direta do valor em USD pela taxa de câmbio atual
  return Number((amount * USD_TO_BRL).toFixed(2));
}

async function fetchAllPrices(source, apiKey) {
  const cacheKey = `allprices:${source}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  logger.request(`Buscando lista de preços: ${source}`);
  try {
    const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
      timeout: 60000,
      params: { api_key: apiKey, source, app_id: 730 },
    });

    const priceMap = new Map();
    for (const [name, info] of Object.entries(data)) {
      // A API v2 retorna sell_price_cents.usd (valor em centavos de dólar)
      const usdPrice = info?.sell_price_cents?.usd;
      if (usdPrice !== undefined) {
        priceMap.set(name, usdPrice / 100);
      }
    }

    logger.success(`${source}: ${priceMap.size} preços carregados`);
    cache.set(cacheKey, priceMap, 15 * 60 * 1000);
    return priceMap;
  } catch (err) {
    logger.error(`Erro ao buscar preços da API (${source}): ${err.message}`);
    return new Map();
  }
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

  logger.info(`${items.length} itens totais → ${uniqueNames.length} itens únicos`);

  // Busca no banco de dados (cache de 6h)
  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: Buscando preços para ${needsAPI.length} itens novos...`);
    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    const toSave = needsAPI.map(name => ({
      name,
      buff: buffMap.get(name) || 0,
      youpin: youpinMap.get(name) || 0
    }));

    // Salva no banco para as próximas 6 horas
    await Promise.all(
      toSave.map(data => db.savePriceToDB(data.name, { buff: data.buff, youpin: data.youpin }))
    );
  }

  const results   = [];
  let totalBuffBRL   = 0;
  let totalYouPinBRL = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);
    let buffUSD, youpinUSD;

    if (dbBatch.has(name)) {
      const data = dbBatch.get(name);
      buffUSD = data.buff;
      youpinUSD = data.youpin;
    } else {
      buffUSD = buffMap.get(name) || 0;
      youpinUSD = youpinMap.get(name) || 0;
    }

    const buffBRL = toBRL(buffUSD) * quantity;
    const youpinBRL = toBRL(youpinUSD) * quantity;
    
    totalBuffBRL += buffBRL;
    totalYouPinBRL += youpinBRL;

    results.push({
      name: item.name || name,
      quantity,
      buffBRL: buffBRL.toFixed(2),
      youpinBRL: youpinBRL.toFixed(2),
      buffUSD: (buffUSD * quantity).toFixed(2),
      youpinUSD: (youpinUSD * quantity).toFixed(2)
    });
  }

  // Ordena por valor total (BRL) decrescente
  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL: totalBuffBRL.toFixed(2),
    totalYouPinBRL: totalYouPinBRL.toFixed(2),
    displayRate: `1 USD = R$ ${USD_TO_BRL.toFixed(4)}`,
    stats: {
      total: items.length,
      unique: uniqueNames.length,
      fromDB: dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };
