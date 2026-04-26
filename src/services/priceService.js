const axios  = require('axios');
const logger = require('../utils/logger');
const engine = require('./CurrencyEngine'); 

async function fetchExchangeRate() {
  try {
    const { data } = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL', { timeout: 8000 });
    const usdBrl = Number(data.USDBRL.bid);
    engine.atualizarCambio(usdBrl, 0); 
    logger.success(`Câmbio Atualizado (Ao Vivo): 1 USD = R$ ${usdBrl.toFixed(3)}`);
  } catch (err) {
    logger.warn(`Falha na API de câmbio. Usando taxas de fallback.`);
  }
}

async function fetchAllPrices(source, apiKey) {
  logger.request(`Baixando tabela de preços atualizada: ${source.toUpperCase()}`);
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

  logger.success(`${source.toUpperCase()}: ${priceMap.size} preços carregados com sucesso.`);
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

  logger.info(`Buscando cotações fresquinhas direto da API...`);
  const [buffMap, youpinMap] = await Promise.all([
    fetchAllPrices('buff163', apiKey),
    fetchAllPrices('youpin',  apiKey),
  ]);

  const results   = [];
  let totalBuffUSD   = 0;
  let totalYouPinUSD = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);

    let buffUSD   = buffMap.get(name) || 0;
    let youpinUSD = youpinMap.get(name) || 0;

    // 🛡️ O ANTI-TROLL DEFINITIVO (Espelhamento da Fonte da Verdade)
    // A BUFF é a maior do mundo, logo, ela dita a regra.
    if (buffUSD === 0) {
        // Se a BUFF não tem o item (ou custa 0), qualquer preço na YouPin é troll. Zera os dois.
        youpinUSD = 0;
    } else if (youpinUSD === 0) {
        // Se a YouPin não tiver o item para vender, copia o preço da BUFF para não afundar o gráfico.
        youpinUSD = buffUSD;
    } else {
        // Corta inflação absurda: Se a YouPin estiver 40% mais cara que a BUFF, corta o preço pro valor da BUFF.
        if (youpinUSD > buffUSD * 1.4) {
            youpinUSD = buffUSD;
        }
        // E vice-versa
        else if (buffUSD > youpinUSD * 1.4) {
            buffUSD = youpinUSD;
        }
    }

    const buffTotalUSD   = buffUSD   * quantity;
    const youpinTotalUSD = youpinUSD * quantity;
    
    totalBuffUSD   += buffTotalUSD;
    totalYouPinUSD += youpinTotalUSD;

    results.push({
      name:      item.name || name,
      quantity,
      buffBRL:   engine.converterPreco(buffTotalUSD, 'USD', 'buff').toFixed(2),
      youpinBRL: engine.converterPreco(youpinTotalUSD, 'USD', 'youpin').toFixed(2),
      buffUSD:   buffTotalUSD.toFixed(2),
      youpinUSD: youpinTotalUSD.toFixed(2),
    });
  }

  results.sort((a, b) => Number(b.buffBRL) - Number(a.buffBRL));

  const totalFinalBuffBRL = engine.converterPreco(totalBuffUSD, 'USD', 'buff');
  const totalFinalYoupinBRL = engine.converterPreco(totalYouPinUSD, 'USD', 'youpin');

  return {
    results,
    totalBuffBRL:   totalFinalBuffBRL.toFixed(2),
    totalYouPinBRL: totalFinalYoupinBRL.toFixed(2),
    displayRate:    `1:1 Cravado (Espelhamento BUFF + Anti-Troll)`,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  0, 
      fromAPI: uniqueNames.length,
    },
  };
}

module.exports = { processInventoryPrices };