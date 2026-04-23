// priceService.js — PRECISO (CNY Nativo -> BRL Ao Vivo)
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

// Taxas de câmbio
let CNY_TO_BRL = 0.78;  // fallback
let USD_TO_BRL = 5.70;  // fallback
let CNY_TO_USD = 0.138; // fallback (aprox 7.24 CNY/USD)
let useDirectCNY = false;

async function fetchExchangeRate() {
  // Taxa manual no .env tem prioridade absoluta
  if (process.env.CUSTOM_USD_TO_BRL) {
    USD_TO_BRL = Number(process.env.CUSTOM_USD_TO_BRL);
    logger.success(`Câmbio (Manual .env): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    return;
  }

  try {
    // Busca USD-BRL, CNY-BRL e USD-CNY para máxima precisão
    const { data } = await axios.get(
      'https://economia.awesomeapi.com.br/last/USD-BRL,CNY-BRL,USD-CNY',
      { timeout: 8000 }
    );

    if (data?.USDBRL?.bid) USD_TO_BRL = Number(data.USDBRL.bid);
    if (data?.CNYBRL?.bid) {
      CNY_TO_BRL = Number(data.CNYBRL.bid);
      useDirectCNY = true;
    }
    if (data?.USDCNY?.bid) {
      // A API retorna USD-CNY (ex: 7.24). Precisamos de CNY-USD para reverter o USD da CSInventoryAPI
      const usdCny = Number(data.USDCNY.bid);
      CNY_TO_USD = 1 / usdCny;
    }

    logger.success(
      `Câmbio ao vivo → 1 CNY = R$ ${CNY_TO_BRL.toFixed(4)} | 1 USD = R$ ${USD_TO_BRL.toFixed(4)} | 1 USD = ${ (1/CNY_TO_USD).toFixed(4) } CNY`
    );
  } catch {
    logger.warn(`Câmbio não atualizado. Usando fallbacks.`);
  }
}

/**
 * Converte o valor em USD retornado pela CSInventoryAPI de volta para CNY e depois para BRL.
 * A CSInventoryAPI converte internamente CNY -> USD usando uma taxa fixa ou de mercado.
 * Para bater com o Buff/YouPin (que são CNY), precisamos desfazer essa conversão.
 */
function toBRL(usdFromAPI) {
  const amount = Number(usdFromAPI);
  if (!amount || amount === 0) return '0.00';

  // 1. Converter USD (API) -> CNY
  // Se a API usou 1 USD = 7.24 CNY, então CNY = USD * 7.24
  const cnyValue = amount / CNY_TO_USD;

  // 2. Converter CNY -> BRL usando taxa real
  return (cnyValue * CNY_TO_BRL).toFixed(2);
}

function getDisplayRate() {
  return `1 CNY = R$ ${CNY_TO_BRL.toFixed(4)} (Base para Buff/YouPin)`;
}

async function fetchAllPrices(source, apiKey) {
  const cacheKey = `allprices:${source}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Preços ${source} (cache em memória)`); return cached; }

  logger.request(`Buscando TODOS os preços: ${source}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    timeout: 60000,
    params: { api_key: apiKey, source, app_id: 730 },
  });

  const priceMap = new Map();
  for (const [name, info] of Object.entries(data)) {
    const cents = info?.sell_price_cents?.usd ?? 0;
    priceMap.set(name, cents / 100);
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

  // Busca no banco (cache de 6h)
  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  logger.success(`Banco: ${dbBatch.size} itens válidos encontrados`);

  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: ${needsAPI.length} itens novos/expirados → Atualizando lista completa`);
    logger.divider();

    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    // Salva no banco apenas o que foi solicitado e não estava lá
    const toSave = needsAPI.map(name => ({
      name,
      buff:   buffMap.get(name)   || 0,
      youpin: youpinMap.get(name) || 0,
    }));

    await Promise.all(
      toSave.map(({ name, buff, youpin }) => db.savePriceToDB(name, { buff, youpin }))
    );
    logger.success(`${toSave.length} itens atualizados no banco`);
  } else {
    logger.info('✅ Cache do banco íntegro (menos de 6h) — 0 requests à API!');
    logger.divider();
  }

  const results   = [];
  let totalBuff   = 0;
  let totalYouPin = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);
    let buff, youpin;

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
    cnyToBrl:       CNY_TO_BRL,
    displayRate:    getDisplayRate(),
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };
