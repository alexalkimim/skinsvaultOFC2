// src/services/priceService.js
const axios  = require('axios');
const logger = require('../utils/logger');
const engine = require('./CurrencyEngine');

async function fetchExchangeRate() {
  try {
    const { data } = await axios.get(
      'https://economia.awesomeapi.com.br/last/USD-BRL,CNY-BRL',
      { timeout: 8000 }
    );
    const usdBrl = Number(data.USDBRL?.bid || 0);
    const cnyBrl = Number(data.CNYBRL?.bid || 0);
    engine.atualizarCambio(usdBrl, cnyBrl);
  } catch (err) {
    logger.warn(
      `Falha na API de câmbio. Usando fallback: ` +
      `1 USD = R$ ${engine.cambio.USD_BRL.toFixed(4)}`
    );
  }
}

async function fetchAllPrices(source, apiKey) {
  logger.request(`Baixando tabela de preços: ${source.toUpperCase()}`);
  const { data } = await axios.get('https://csinventoryapi.com/api/v2/prices', {
    timeout: 60000,
    params: { api_key: apiKey, source, app_id: 730 },
  });

  const pricesObj = (data && typeof data === 'object' && !data.sell_price_cents)
    ? (data.data || data.items || data)
    : data;

  const priceMap = new Map();
  for (const [name, info] of Object.entries(pricesObj)) {
    if (name === 'success' || typeof info !== 'object' || !info) continue;
    const centavos = info?.sell_price_cents?.usd;
    if (centavos && Number(centavos) > 0) {
      priceMap.set(name, Number(centavos) / 100);
    }
  }

  logger.success(`${source.toUpperCase()}: ${priceMap.size} preços carregados.`);
  return priceMap;
}

function deduplicateItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const name = item.market_hash_name;
    if (!name) continue;
    if (grouped.has(name)) {
      grouped.get(name).quantity++;
    } else {
      grouped.set(name, { item, quantity: 1 });
    }
  }
  return grouped;
}

async function processInventoryPrices(items, apiKey) {
  await fetchExchangeRate();

  const taxa    = engine.getTaxa();
  const grouped = deduplicateItems(items);
  const names   = [...grouped.keys()];

  logger.info(`Processando ${names.length} itens únicos...`);

  const [buffMap, youpinMap] = await Promise.all([
    fetchAllPrices('buff163', apiKey),
    fetchAllPrices('youpin',  apiKey),
  ]);

  const results      = [];
  let totalBuffUSD   = 0;
  let totalYoupinUSD = 0;

  for (const name of names) {
    const { item, quantity } = grouped.get(name);

    const buffUSDUnit   = buffMap.get(name)   || 0;
    const youpinUSDUnit = youpinMap.get(name) || 0;

    const buffTotalUSD   = buffUSDUnit   * quantity;
    const youpinTotalUSD = youpinUSDUnit * quantity;

    totalBuffUSD   += buffTotalUSD;
    totalYoupinUSD += youpinTotalUSD;

    const buffTotalBRL   = engine.usdParaBrl(buffTotalUSD);
    const youpinTotalBRL = engine.usdParaBrl(youpinTotalUSD);

    results.push({
      name:          item.name || name,
      marketName:    name,
      quantity,
      buffUSD:       buffTotalUSD.toFixed(2),
      youpinUSD:     youpinTotalUSD.toFixed(2),
      buffBRL:       buffTotalBRL.toFixed(2),
      youpinBRL:     youpinTotalBRL.toFixed(2),
      buffUSDUnit:   buffUSDUnit.toFixed(2),
      youpinUSDUnit: youpinUSDUnit.toFixed(2),
      buffBRLUnit:   engine.usdParaBrl(buffUSDUnit).toFixed(2),
      youpinBRLUnit: engine.usdParaBrl(youpinUSDUnit).toFixed(2),
    });
  }

  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  const totalBuffBRL   = engine.usdParaBrl(totalBuffUSD);
  const totalYoupinBRL = engine.usdParaBrl(totalYoupinUSD);

  return {
    results,
    totalBuffBRL:   totalBuffBRL.toFixed(2),
    totalYouPinBRL: totalYoupinBRL.toFixed(2),
    displayRate:
      `1 USD = R$ ${taxa.usdBrl.toFixed(4)} | ` +
      `1 CNY = R$ ${taxa.cnyBrl.toFixed(4)} | ` +
      `Spread: ${taxa.spread}%`,
    stats: {
      total:   items.length,
      unique:  names.length,
      fromDB:  0,
      fromAPI: names.length,
    },
  };
}

module.exports = { processInventoryPrices };