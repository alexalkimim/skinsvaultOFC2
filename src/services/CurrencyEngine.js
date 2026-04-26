// src/services/CurrencyEngine.js
const logger = require('../utils/logger');

class CurrencyEngine {
  constructor() {
    this.cambio = {
      USD_BRL: 4.98,
      CNY_BRL: 0.687,
    };
    const spreadEnv = Number(process.env.BRL_SPREAD_PERCENT || 0);
    this.spreadFator = 1 + (spreadEnv / 100);
  }

  atualizarCambio(usdBrl, cnyBrl) {
    if (usdBrl > 0) this.cambio.USD_BRL = usdBrl;
    if (cnyBrl > 0) this.cambio.CNY_BRL = cnyBrl;
    logger.success(
      `Câmbio ao vivo: 1 USD = R$ ${this.cambio.USD_BRL.toFixed(4)} | ` +
      `1 CNY = R$ ${this.cambio.CNY_BRL.toFixed(4)} | ` +
      `Spread: ${((this.spreadFator - 1) * 100).toFixed(2)}%`
    );
  }

  // Ambos Buff e YouPin: a API entrega em USD → multiplica por USD_BRL ao vivo
  usdParaBrl(valorUSD) {
    if (!valorUSD || valorUSD <= 0) return 0;
    return Math.round(valorUSD * this.cambio.USD_BRL * this.spreadFator * 100) / 100;
  }

  getTaxa() {
    return {
      usdBrl: this.cambio.USD_BRL,
      cnyBrl: this.cambio.CNY_BRL,
      spread: ((this.spreadFator - 1) * 100).toFixed(2),
    };
  }
}

module.exports = new CurrencyEngine();