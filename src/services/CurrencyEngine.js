// CurrencyEngine.js — COM CALIBRAÇÃO EXATA YOUPIN
const logger = require('../utils/logger');

class CurrencyEngine {
  constructor() {
    this.cambio = {
      USD_BRL: 5.00,
      CNY_BRL: 0.74,
      CNY_USD: 0.148 
    };

    // A taxa interna obscura da Buff (Descoberta na engenharia reversa)
    this.BUFF_INTERNAL_CNY_TO_USD = 1 / 6.445; 

    this.perfis = {
      buff: {
        moedaNativa: 'CNY',
        taxaFixa: 0,
        spreadCambial: 0,
        arredondamento: 'round',
        casas: 2,
        // 🔥 CALIBRADO: Corrige o corte de 6.5% que a API faz na Buff
        fatorCalibracao: 1.065 
      },
      youpin: {
        moedaNativa: 'CNY',
        taxaFixa: 0,
        spreadCambial: 0,
        arredondamento: 'floor',
        casas: 2,
        // 🔥 A MÁGICA AQUI: 1.0077 corrige exatamente a distorção do Dólar da YouPin para bater os ~768!
        fatorCalibracao: 1.0077 
      },
      csfloat: {
        moedaNativa: 'USD',
        taxaFixa: 0,
        spreadCambial: 0.025, 
        arredondamento: 'round',
        casas: 2,
        fatorCalibracao: 1.0
      },
      skinport: {
        moedaNativa: 'BRL', 
        taxaFixa: 0,
        spreadCambial: 0.04, 
        arredondamento: 'ceil',
        casas: 2,
        fatorCalibracao: 1.0
      },
      steam: {
        moedaNativa: 'BRL',
        taxaFixa: 0.15, 
        spreadCambial: 0,
        arredondamento: 'floor',
        casas: 2,
        fatorCalibracao: 1.0
      }
    };
  }

  atualizarCambio(usdBrl, cnyBrl) {
    this.cambio.USD_BRL = usdBrl;
    this.cambio.CNY_BRL = cnyBrl;
    this.cambio.CNY_USD = cnyBrl / usdBrl;
  }

  aplicarArredondamento(valor, metodo, casas) {
    const multiplicador = Math.pow(10, casas);
    switch (metodo) {
      case 'floor': return Math.floor(valor * multiplicador) / multiplicador;
      case 'ceil':  return Math.ceil(valor * multiplicador) / multiplicador;
      case 'round': default: return Math.round(valor * multiplicador) / multiplicador;
    }
  }

  converterPreco(valor, moedaOrigem, site) {
    const perfil = this.perfis[site.toLowerCase()];
    if (!perfil) throw new Error(`Site não suportado: ${site}`);

    let valorBaseBRL = 0;

    if (moedaOrigem === 'CNY') {
      valorBaseBRL = valor * this.cambio.CNY_BRL;
    } else if (moedaOrigem === 'USD') {
      valorBaseBRL = valor * this.cambio.USD_BRL;
    } else if (moedaOrigem === 'BRL') {
      valorBaseBRL = valor;
    } else if (moedaOrigem === 'BUFF_USD_FAKE') {
      const cnyReal = valor / this.BUFF_INTERNAL_CNY_TO_USD;
      valorBaseBRL = cnyReal * this.cambio.CNY_BRL;
    }

    let valorComSpread = valorBaseBRL * (1 + perfil.spreadCambial);
    let valorComTaxa = valorComSpread * (1 + perfil.taxaFixa);
    let valorCalibrado = valorComTaxa * perfil.fatorCalibracao;

    return this.aplicarArredondamento(valorCalibrado, perfil.arredondamento, perfil.casas);
  }

  calibrarAutomaticamente(site, valorOrigem, moedaOrigem, valorRealNoSiteBRL) {
    const perfil = this.perfis[site.toLowerCase()];
    if (!perfil) return;

    const fatorAntigo = perfil.fatorCalibracao;
    perfil.fatorCalibracao = 1.0; 
    
    const valorCalculadoPuro = this.converterPreco(valorOrigem, moedaOrigem, site);
    const fatorIdeal = valorRealNoSiteBRL / valorCalculadoPuro;

    const alpha = 0.2; 
    perfil.fatorCalibracao = (fatorAntigo * (1 - alpha)) + (fatorIdeal * alpha);

    logger.info(`[Calibração] ${site.toUpperCase()} ajustado. Fator: ${perfil.fatorCalibracao.toFixed(4)}`);
  }
}

module.exports = new CurrencyEngine();