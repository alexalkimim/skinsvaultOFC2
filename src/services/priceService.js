// priceService.js — OTIMIZADO COM YUAN (CNY)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Câmbio CNY → BRL
let CNY_TO_BRL = 0.80; // Fallback inicial (1 CNY ~= 0.80 BRL)

async function fetchExchangeRate() {
  try {
    const { data } = await axios.get('https://api.exchangerate-api.com/v4/latest/CNY', { timeout: 8000 });
    if (data?.rates?.BRL) {
      CNY_TO_BRL = data.rates.BRL;
      logger.success(`Câmbio: 1 CNY = R$ ${CNY_TO_BRL.toFixed(3)}`);
    }
  } catch {
    logger.warn(`Câmbio não atualizado. Usando R$ ${CNY_TO_BRL.toFixed(3)}`);
  }
}

const toBRL = (cny) => (Number(cny) * CNY_TO_BRL).toFixed(2);

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
    let cnyPrice = 0;
    
    // Tenta pegar o CNY direto se a API enviar (muitas APIs enviam "cny" oculto)
    if (info?.sell_price_cents?.cny) {
      cnyPrice = info.sell_price_cents.cny / 100;
    } 
    // Fallback: Se enviar apenas USD, revertemos a conversão pro valor original do Buff
    else if (info?.sell_price_cents?.usd) {
      const usdPrice = info.sell_price_cents.usd / 100;
      // 7.22 é a taxa média do dólar/rmb usada nos sites chineses. 
      // Caso precise ajustar a precisão, basta alterar este número (ex: 7.23, 7.25)
      cnyPrice = usdPrice * 7.22; 
    }

    priceMap.set(name, cnyPrice);
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
      logger.info(`Salvando ${toSave.length} preços no banco...`);
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

    const buffTotal   = buff   * quantity;
    const youpinTotal = youpin * quantity;
    totalBuff   += buffTotal;
    totalYouPin += youpinTotal;

    results.push({
      name:      item.name || name,
      quantity,
      buffBRL:   toBRL(buffTotal),
      youpinBRL: toBRL(youpinTotal),
      buffCNY:   buffTotal.toFixed(2),
      youpinCNY: youpinTotal.toFixed(2),
    });
  }

  // Ordena por valor BUFF (maior → menor)
  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL:   toBRL(totalBuff),
    totalYouPinBRL: toBRL(totalYouPin),
    cnyToBRL:       CNY_TO_BRL,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };