// priceService.js — MEGA OTIMIZADO: 2 requests para TODO o inventário
//
// Como funciona:
//   GET /api/v2/prices?source=buff163  → retorna TODOS os itens (1 request point)
//   GET /api/v2/prices?source=youpin   → retorna TODOS os itens (1 request point)
//   Total: 2 requests independente do tamanho do inventário!
//
// Preços da API vêm em CENTAVOS → dividir por 100 para ter USD

const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Câmbio USD → BRL
let USD_TO_BRL = 5.70;

async function fetchExchangeRate() {
  try {
    const { data } = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 8000 });
    if (data?.rates?.BRL) {
      USD_TO_BRL = data.rates.BRL;
      logger.success(`Câmbio: 1 USD = R$ ${USD_TO_BRL.toFixed(2)}`);
    }
  } catch {
    logger.warn(`Câmbio não atualizado. Usando R$ ${USD_TO_BRL.toFixed(2)}`);
  }
}

const toBRL = (usd) => (Number(usd) * USD_TO_BRL).toFixed(2);

// ---------------------------------------------------------
// BUSCA TODOS OS PREÇOS DE UMA VEZ — 1 request point!
// Retorna Map: market_hash_name → preço em USD (float)
// ---------------------------------------------------------

async function fetchAllPrices(source, apiKey) {
  const cacheKey = `allprices:${source}`;
  const cached   = cache.get(cacheKey);
  if (cached) { logger.cache(`Preços ${source} (cache)`); return cached; }

  logger.request(`Buscando TODOS os preços: ${source}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    timeout: 60000, // resposta grande, timeout maior
    params: { api_key: apiKey, source, app_id: 730 },
  });

  // Converte para Map: name → preço em USD
  // API retorna centavos → dividir por 100
  const priceMap = new Map();
  for (const [name, info] of Object.entries(data)) {
    const cents = info?.sell_price_cents?.usd ?? 0;
    priceMap.set(name, cents / 100);
  }

  logger.success(`${source}: ${priceMap.size} itens carregados`);

  // Cache por 15 minutos (preços mudam lentamente)
  cache.set(cacheKey, priceMap, 15 * 60 * 1000);
  return priceMap;
}

// ---------------------------------------------------------
// DEDUPLICAÇÃO
// ---------------------------------------------------------

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

// ---------------------------------------------------------
// PROCESSAMENTO PRINCIPAL
// ---------------------------------------------------------

async function processInventoryPrices(items, apiKey) {
  // 1. Atualiza câmbio
  await fetchExchangeRate();

  const grouped     = deduplicateItems(items);
  const uniqueNames = [...grouped.keys()];

  logger.info(`${items.length} itens → ${uniqueNames.length} únicos`);

  // 2. Verifica banco (1 query para tudo)
  logger.info('Verificando banco de dados...');
  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  logger.success(`Banco: ${dbBatch.size} itens válidos encontrados`);

  // Itens que precisam de preço fresco da API
  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: buscando preços para ${needsAPI.length} itens não cacheados`);
    logger.divider();

    // 3. APENAS 2 REQUESTS para TODO o inventário
    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    // 4. Salva novos preços no banco
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

  // 5. Monta resultados
  const results   = [];
  let totalBuff   = 0;
  let totalYouPin = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);

    // Prioridade: banco → mapa da API → 0
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
    });
  }

  // Ordena por valor BUFF (maior → menor)
  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  return {
    results,
    totalBuffBRL:   toBRL(totalBuff),
    totalYouPinBRL: toBRL(totalYouPin),
    usdToBRL:       USD_TO_BRL,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };