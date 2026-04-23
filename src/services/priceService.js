// priceService.js — PRECISÃO MÁXIMA
const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

// Taxas de câmbio (Fallbacks caso a API de câmbio falhe)
let USD_TO_BRL = 6.15; 
let CNY_TO_BRL = 0.85;

async function fetchExchangeRates() {
  // Se houver câmbio manual no .env, priorizamos
  if (process.env.CUSTOM_USD_TO_BRL) {
    USD_TO_BRL = Number(process.env.CUSTOM_USD_TO_BRL);
    logger.success(`Câmbio USD (Manual .env): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
  } else {
    try {
      const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL', { timeout: 8000 });
      if (data?.USDBRL?.bid) {
        USD_TO_BRL = Number(data.USDBRL.bid);
        logger.success(`Câmbio USD ao vivo → 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
      }
    } catch {
      logger.warn(`Câmbio USD não atualizado. Usando fallback: USD=R$ ${USD_TO_BRL}`);
    }
  }

  // Buscamos CNY (Yuan) para BRL para maior precisão nos preços do Buff/YouPin
  try {
    const { data } = await axios.get('https://economia.awesomeapi.com.br/last/CNY-BRL', { timeout: 8000 });
    if (data?.CNYBRL?.bid) {
      CNY_TO_BRL = Number(data.CNYBRL.bid);
      logger.success(`Câmbio CNY ao vivo → 1 CNY = R$ ${CNY_TO_BRL.toFixed(4)}`);
    }
  } catch {
    logger.warn(`Câmbio CNY não atualizado. Usando fallback: CNY=R$ ${CNY_TO_BRL}`);
  }
}

/**
 * Converte o valor retornado pela API para BRL com precisão máxima.
 * A API retorna sell_price_cents que contém sub-campos para várias moedas.
 */
function calculateBRL(priceInfo) {
  if (!priceInfo || !priceInfo.sell_price_cents) return 0;
  
  const cents = priceInfo.sell_price_cents;
  
  // Prioridade 1: CNY (Yuan) - É a moeda nativa do Buff/YouPin, gera menos erro de arredondamento
  if (cents.cny) {
    return Number(((cents.cny / 100) * CNY_TO_BRL).toFixed(2));
  }
  
  // Prioridade 2: USD (Dólar)
  if (cents.usd) {
    return Number(((cents.usd / 100) * USD_TO_BRL).toFixed(2));
  }

  return 0;
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
      // Guardamos o objeto de preço completo para processar com a melhor moeda disponível depois
      if (info?.sell_price_cents) {
        priceMap.set(name, info);
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
  await fetchExchangeRates();

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
      buffInfo: buffMap.get(name),
      youpinInfo: youpinMap.get(name)
    }));

    // Salva no banco para as próximas 6 horas (armazenamos o preço final em BRL para garantir consistência)
    await Promise.all(
      toSave.map(data => db.savePriceToDB(data.name, { 
        buff: calculateBRL(data.buffInfo), 
        youpin: calculateBRL(data.youpinInfo) 
      }))
    );
  }

  const results   = [];
  let totalBuffBRL   = 0;
  let totalYouPinBRL = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);
    let buffBRLSingle, youpinBRLSingle;

    if (dbBatch.has(name)) {
      const data = dbBatch.get(name);
      buffBRLSingle = data.buff;
      youpinBRLSingle = data.youpin;
    } else {
      buffBRLSingle = calculateBRL(buffMap.get(name));
      youpinBRLSingle = calculateBRL(youpinMap.get(name));
    }

    const buffBRLTotal = buffBRLSingle * quantity;
    const youpinBRLTotal = youpinBRLSingle * quantity;
    
    totalBuffBRL += buffBRLTotal;
    totalYouPinBRL += youpinBRLTotal;

    results.push({
      name: item.name || name,
      quantity,
      buffBRL: buffBRLTotal.toFixed(2),
      youpinBRL: youpinBRLTotal.toFixed(2),
      // Mantemos USD apenas para exibição aproximada
      buffUSD: ((buffBRLTotal) / USD_TO_BRL).toFixed(2),
      youpinUSD: ((youpinBRLTotal) / USD_TO_BRL).toFixed(2)
    });
  }

  // Ordena por valor total (BRL) decrescente
  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL: totalBuffBRL.toFixed(2),
    totalYouPinBRL: totalYouPinBRL.toFixed(2),
    displayRate: `1 USD = R$ ${USD_TO_BRL.toFixed(2)} | 1 CNY = R$ ${CNY_TO_BRL.toFixed(4)}`,
    stats: {
      total: items.length,
      unique: uniqueNames.length,
      fromDB: dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };
