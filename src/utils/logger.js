// ============================================================
// logger.js — Log colorido no terminal
// ============================================================

const COLORS = {
  reset:  '\x1b[0m',
  bright: '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
  white:  '\x1b[37m',
  magenta:'\x1b[35m',
};

const timestamp = () => {
  const now = new Date();
  return `${COLORS.gray}${now.toLocaleTimeString('pt-BR')}${COLORS.reset}`;
};

const logger = {
  info(msg) {
    console.log(`${timestamp()} ${COLORS.cyan}[INFO]${COLORS.reset}     ${msg}`);
  },

  success(msg) {
    console.log(`${timestamp()} ${COLORS.green}[OK]${COLORS.reset}       ${msg}`);
  },

  cache(msg) {
    console.log(`${timestamp()} ${COLORS.yellow}[CACHE HIT]${COLORS.reset} ${msg}`);
  },

  request(msg) {
    console.log(`${timestamp()} ${COLORS.blue}[REQUEST]${COLORS.reset}  ${msg}`);
  },

  warn(msg) {
    console.log(`${timestamp()} ${COLORS.magenta}[WARN]${COLORS.reset}     ${msg}`);
  },

  error(msg) {
    console.log(`${timestamp()} ${COLORS.red}[ERROR]${COLORS.reset}    ${msg}`);
  },

  debug(msg) {
    if (process.env.DEBUG === 'true') {
      console.log(`${timestamp()} ${COLORS.gray}[DEBUG]${COLORS.reset}    ${msg}`);
    }
  },

  divider() {
    console.log(`${COLORS.gray}${'─'.repeat(60)}${COLORS.reset}`);
  },

  banner(text) {
    const line = '═'.repeat(text.length + 4);
    console.log(`\n${COLORS.bright}${COLORS.cyan}╔${line}╗`);
    console.log(`║  ${text}  ║`);
    console.log(`╚${line}╝${COLORS.reset}\n`);
  },
};

module.exports = logger;
