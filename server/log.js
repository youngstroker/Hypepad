// One JSON line per event, so logs can go straight into any log collector.
const write = (level, event, data) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...data });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};

export const log = {
    info: (event, data = {}) => write('info', event, data),
    warn: (event, data = {}) => write('warn', event, data),
    error: (event, data = {}) => write('error', event, data),
};
