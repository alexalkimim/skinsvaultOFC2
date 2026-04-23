// priceService.js — PRECISO (CNY Nativo -> BRL Ao Vivo)
//
// MUDANÇAS CRÍTICAS vs versão anterior:
//   1. Removido filtro "Anti-Troll" — causava preços artificiais
//   2. Salva TODOS os itens no banco, incluindo preço 0 (graffitis, stickers)
//      → Sem isso, itens com preço 0 re-buscavam API em cada execução
//   3. Câmbio via CNY→BRL direto (Buff/YouPin são plataformas em CNY)
//   4. Fallback USD→BRL se CNY falhar

const axios  = require('axios');
const logger = require('../utils/logger');
const cache  = require('../utils/cache');
const db     = require('./dbService');

// Taxa CNY→BRL (e fallback USD→BRL)
let CNY_TO_BRL = 0.78;  // fallback
let USD_TO_BRL = 5.70;  // fallback
let useDirectCNY = false; // se conseguimos a taxa CNY direta

async function fetchExchangeRate() {
  // Taxa manual no .env tem prioridade absoluta
  if (process.env.CUSTOM_USD_TO_BRL) {
    USD_TO_BRL = Number(process.env.CUSTOM_USD_TO_BRL);
    logger.success(`Câmbio (Manual .env): 1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    return;
  }

  try {
    // Busca USD-BRL E CNY-BRL ao mesmo tempo (1 chamada, 2 pares)
    const { data } = await axios.get(
      'https://economia.awesomeapi.com.br/last/USD-BRL,CNY-BRL',
      { timeout: 8000 }
    );

    if (data?.USDBRL?.bid) {
      USD_TO_BRL = Number(data.USDBRL.bid);
    }

    if (data?.CNYBRL?.bid) {
      CNY_TO_BRL   = Number(data.CNYBRL.bid);
      useDirectCNY = true;
      logger.success(
        `Câmbio ao vivo →  1 USD = R$ ${USD_TO_BRL.toFixed(4)}  |  1 CNY = R$ ${CNY_TO_BRL.toFixed(4)}`
      );
    } else {
      logger.success(`Câmbio ao vivo →  1 USD = R$ ${USD_TO_BRL.toFixed(4)}`);
    }
  } catch {
    logger.warn(`Câmbio não atualizado. USD=${USD_TO_BRL.toFixed(4)} CNY=${CNY_TO_BRL.toFixed(4)}`);
  }
}

// Converte USD (como retornado pela API) para BRL
// A API já converteu CNY→USD internamente usando a taxa deles.
// Para compensar a taxa interna da API (geralmente 7.2 CNY/USD),
// reconvertemos para CNY e depois para BRL usando a taxa real.
const API_INTERNAL_CNY_USD = 7.20; // taxa interna aproximada da csinventoryapi

function toBRL(usdFromAPI) {
  const amount = Number(usdFromAPI);
  if (!amount) return '0.00';

  if (useDirectCNY) {
    // Reconverte USD (da API) → CNY → BRL usando taxas reais
    const cny = amount * API_INTERNAL_CNY_USD;
    return (cny * CNY_TO_BRL).toFixed(2);
  }
  // Fallback: USD direto
  return (amount * USD_TO_BRL).toFixed(2);
}

// Mantém a taxa USD para exibição no cabeçalho
function getDisplayRate() {
  if (useDirectCNY) return `1 CNY = R$ ${CNY_TO_BRL.toFixed(4)} (via CNY nativo)`;
  return `1 USD = R$ ${USD_TO_BRL.toFixed(4)}`;
}

// ---------------------------------------------------------
// BUSCA TODOS OS PREÇOS — 1 request point por source
// ---------------------------------------------------------
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
    // API retorna centavos em USD → dividir por 100
    const cents = info?.sell_price_cents?.usd ?? 0;
    priceMap.set(name, cents / 100); // guarda em USD float
  }

  logger.success(`${source}: ${priceMap.size} itens carregados`);
  // Cache 15 min — preços mudam devagar
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
  await fetchExchangeRate();

  const grouped     = deduplicateItems(items);
  const uniqueNames = [...grouped.keys()];

  logger.info(`${items.length} itens → ${uniqueNames.length} únicos`);

  // 1 query para buscar TUDO no banco
  const dbBatch = await db.getBatchPricesFromDB(uniqueNames);
  logger.success(`Banco: ${dbBatch.size} itens válidos encontrados`);

  // Apenas itens SEM entrada no banco vão para a API
  const needsAPI = uniqueNames.filter(n => !dbBatch.has(n));

  let buffMap   = new Map();
  let youpinMap = new Map();

  if (needsAPI.length > 0) {
    logger.info(`API: ${needsAPI.length} itens sem cache no banco → 2 requests`);
    logger.divider();

    // 2 requests para TODO o CS2 — independente do tamanho do inventário
    [buffMap, youpinMap] = await Promise.all([
      fetchAllPrices('buff163', apiKey),
      fetchAllPrices('youpin',  apiKey),
    ]);

    // CORREÇÃO CRÍTICA: salva TODOS os itens, incluindo preço 0
    // Sem isso, itens sem preço (graffitis, stickers baratos) são re-buscados
    // na API em CADA execução, gastando tokens desnecessariamente
    const toSave = needsAPI.map(name => ({
      name,
      buff:   buffMap.get(name)   || 0,
      youpin: youpinMap.get(name) || 0,
    }));

    await Promise.all(
      toSave.map(({ name, buff, youpin }) => db.savePriceToDB(name, { buff, youpin }))
    );
    logger.success(`${toSave.length} itens salvos no banco (incluindo preço zero)`);

  } else {
    logger.info('✅ Todos os preços vieram do banco — 0 requests à API!');
    logger.divider();
  }

  // ---------------------------------------------------------
  // Monta resultados finais
  // ---------------------------------------------------------
  const results   = [];
  let totalBuff   = 0;
  let totalYouPin = 0;

  for (const name of uniqueNames) {
    const { item, quantity } = grouped.get(name);

    let buff, youpin;

    if (dbBatch.has(name)) {
      // Veio do banco
      buff   = dbBatch.get(name).buff;
      youpin = dbBatch.get(name).youpin;
    } else {
      // Veio da API agora
      buff   = buffMap.get(name)   || 0;
      youpin = youpinMap.get(name) || 0;
    }

    // SEM filtro Anti-Troll — ele causava preços artificiais
    // Ex: Karambit Fade onde buff=800 e youpin=350 — são preços REAIS diferentes

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