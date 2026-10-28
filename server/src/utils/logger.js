const colors = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m' };
const reset = '\x1b[0m';

const write = (level, args) => {
  const time = new Date().toLocaleTimeString();
  const label = `${colors[level]}[${level.toUpperCase()}]${reset}`;
  (level === 'error' ? console.error : console.log)(`${time} ${label}`, ...args);
};

export const logger = {
  info: (...args) => write('info', args),
  ok: (...args) => write('ok', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
