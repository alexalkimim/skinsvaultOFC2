const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');
const engine = require('./CurrencyEngine'); 

async function fetchExchangeRate() {
  try {
    const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL,CNY-BRL', { timeout: 8000 });
    const usdBrl = Number(data.USDBRL.bid);
    const cnyBrl = process.env.BUFF_BALANCE_RATE ? Number(process.env.BUFF_BALANCE_RATE) : Number(data.CNYBRL.bid);

    engine.atualizarCambio(usdBrl, cnyBrl);
    logger.success(`Motor Financeiro OK: 1 USD = R$ ${usdBrl.toFixed(2)} | 1 CNY (Saldo) = R$ ${cnyBrl.toFixed(4)}`);
  } catch (err) {
    logger.warn(`Falha na API de câmbio. Usando taxas internas.`);
  }
}

async function fetchAllPrices(source, apiKey) {
  // Ignoramos o cache local para forçar o download dos preços frescos!
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
    if (info?.sell_price_cents?.usd) priceUSD = Number(info.sell_price_cents.usd) / 100;
    else if (info?.sell_price) priceUSD = Number(info.sell_price);
    
    priceMap.set(name, priceUSD);
  }

  logger.success(`${source}: ${priceMap.size} preços carregados`);
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

    // 🛡️ O EMPRÉSTIMO: Se a Buff der falha (0) num graffiti mas a Youpin tiver, copiamos!
    if (buffUSD === 0 && youpinUSD > 0) buffUSD = youpinUSD;
    if (youpinUSD === 0 && buffUSD > 0) youpinUSD = buffUSD;

    // 🛡️ O ANTI-TROLL: Corta picos absurdos de manipulação (3x maior)
    if (buffUSD > 0 && youpinUSD > buffUSD * 3) youpinUSD = buffUSD; 
    else if (youpinUSD > 0 && buffUSD > youpinUSD * 3) buffUSD = youpinUSD;

    if (buffUSD === 0 && youpinUSD === 0) {
      logger.warn(`Sem preço (API V2): ${name}`);
    }

    const buffTotalUSD   = buffUSD   * quantity;
    const youpinTotalUSD = youpinUSD * quantity;
    
    totalBuffUSD   += buffTotalUSD;
    totalYouPinUSD += youpinTotalUSD;

    results.push({
      name:      item.name || name,
      quantity,
      buffBRL:   engine.converterPreco(buffTotalUSD, 'BUFF_USD_FAKE', 'buff').toFixed(2),
      youpinBRL: engine.converterPreco(youpinTotalUSD, 'BUFF_USD_FAKE', 'youpin').toFixed(2),
      buffUSD:   buffTotalUSD.toFixed(2),
      youpinUSD: youpinTotalUSD.toFixed(2),
    });
  }

  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  const totalFinalBuffBRL = engine.converterPreco(totalBuffUSD, 'BUFF_USD_FAKE', 'buff');
  const totalFinalYoupinBRL = engine.converterPreco(totalYouPinUSD, 'BUFF_USD_FAKE', 'youpin');

  return {
    results,
    totalBuffBRL:   totalFinalBuffBRL.toFixed(2),
    totalYouPinBRL: totalFinalYoupinBRL.toFixed(2),
    displayRate:    `Inteligência Cambial (Motor V1) Ativa`,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  dbBatch.size,
      fromAPI: needsAPI.length,
    },
  };
}

module.exports = { processInventoryPrices };