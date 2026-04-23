// ============================================================
// cache.js — Cache em memória com TTL (Time-To-Live)
// ============================================================

class Cache {
  constructor() {
    // Map é mais performático que Object para cache
    this.store = new Map();
    this.hits  = 0;
    this.misses = 0;
  }

  /**
   * Guarda um valor no cache
   * @param {string} key     - Chave única
   * @param {*}      value   - Valor a guardar
   * @param {number} ttlMs   - Tempo de vida em ms (padrão: 5 min)
   */
  set(key, value, ttlMs = 5 * 60 * 1000) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Busca um valor; retorna null se inexistente ou expirado
   * @param {string} key
   * @returns {*|null}
   */
  get(key) {
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Verifica expiração
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Verifica se a chave existe e é válida
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Remove uma entrada
   */
  delete(key) {
    this.store.delete(key);
  }

  /**
   * Limpa entradas expiradas (manutenção)
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Estatísticas do cache
   */
  stats() {
    return {
      size:     this.store.size,
      hits:     this.hits,
      misses:   this.misses,
      hitRate:  this.hits + this.misses > 0
        ? `${((this.hits / (this.hits + this.misses)) * 100).toFixed(1)}%`
        : '0%',
    };
  }

  /**
   * Limpa tudo
   */
  clear() {
    this.store.clear();
    this.hits  = 0;
    this.misses = 0;
  }
}

// Exporta instância singleton — compartilhada por todo o app
module.exports = new Cache();
