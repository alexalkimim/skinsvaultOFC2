// src/jobs/calibrador.js
// Verifica a coerência da taxa de câmbio usando um item sentinela real.
// Não usa scraping — apenas as APIs disponíveis.
const axios  = require('axios');
const engine = require('../services/CurrencyEngine');
const logger = require('../utils/logger');

// Item sentinela: volume alto no Buff, fácil de verificar manualmente
const SENTINEL_ITEM = 'AK-47 | Redline (Field-Tested)';

async function calibrarTaxa(apiKey) {
  logger.info('Calibrador: verificando coerência da taxa de câmbio...');
  try {
    const encoded = encodeURIComponent(SENTINEL_ITEM);
    const { data } = await axios.get(
      `https://csinventoryapi.com/api/v2/prices/${encoded}`,
      {
        params:  { api_key: apiKey, source: 'buff163' },
        timeout: 10000,
      }
    );

    const centavos = data?.sell_price_cents?.usd;
    if (!centavos || centavos <= 0) {
      logger.warn('Calibrador: sem preço para o item sentinela.');
      return;
    }

    const precoUSD = centavos / 100;
    const precoBRL = engine.usdParaBrl(precoUSD);
    const taxa     = engine.getTaxa();

    logger.info(
      `Calibrador | ${SENTINEL_ITEM}:\n` +
      `  USD:   $${precoUSD.toFixed(2)}\n` +
      `  BRL:   R$ ${precoBRL.toFixed(2)}\n` +
      `  Taxa:  1 USD = R$ ${taxa.usdBrl.toFixed(4)}\n` +
      `  Spread: ${taxa.spread}%`
    );
    logger.success('Calibrador: taxa verificada. Compare com o Buff manualmente para ajustar BRL_SPREAD_PERCENT.');
  } catch (err) {
    logger.warn(`Calibrador: erro — ${err.message}`);
  }
}

module.exports = { calibrarTaxa };