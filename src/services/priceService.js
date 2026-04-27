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
    logger.warn(`Falha na API de câmbio. A usar taxas de fallback.`);
  }
}

async function fetchAllPrices(source, apiKey) {
  logger.request(`A transferir tabela de preços atualizada: ${source.toUpperCase()}`);
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

  logger.info(`A procurar cotações fresquinhas direto da API...`);
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

    // 🛡️ O ANTI-TROLL INTELIGENTE (O Definitivo)
    // 1. Zera Trolls de lixo: Grafites e adesivos que na BUFF não valem nada (menos de 0.05)
    if (buffUSD <= 0.05) {
        youpinUSD = buffUSD;
    } 
    // 2. Se a YouPin não tiver o item
    else if (youpinUSD === 0) {
        youpinUSD = buffUSD;
    } 
    // 3. Apenas para ITENS BARATOS (abaixo de $5 dólares), aplicamos uma trava
    // contra espertinhos que listam skins podres por preços altos.
    else if (buffUSD < 5.00) {
        if (youpinUSD > buffUSD * 1.5) {
            youpinUSD = buffUSD;
        }
    }
    // ✨ NOTA: Se a skin for cara (como a luva Imperial Plaid), o código IGNORA AS TRAVAS
    // e deixa passar o valor real de mercado da YouPin, custe o que custar!

    const buffTotalUSD   = buffUSD   * quantity;
    const youpinTotalUSD = youpinUSD * quantity;
    
    totalBuffUSD   += buffTotalUSD;
    totalYouPinUSD += youpinTotalUSD;

    results.push({
      name:      item.name || name,
      quantity,
      buffUnitBRL: engine.converterPreco(buffUSD, 'USD', 'buff').toFixed(2),
      youpinUnitBRL: engine.converterPreco(youpinUSD, 'USD', 'youpin').toFixed(2),
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
    displayRate:    `Verdade de Mercado (Filtro Inteligente)`,
    stats: {
      total:   items.length,
      unique:  uniqueNames.length,
      fromDB:  0, 
      fromAPI: uniqueNames.length,
    },
  };
}

module.exports = { processInventoryPrices };