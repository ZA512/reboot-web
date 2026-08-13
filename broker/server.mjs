import { createBroker } from './broker.mjs';
import { loadConfig } from './config.mjs';

try {
  const config = loadConfig();
  const { server, database } = createBroker(config);
  server.listen(config.port, config.host, () => console.info(JSON.stringify({ event: 'broker_started', host: config.host, port: config.port })));
  function shutdown() { server.close(() => { database.close(); process.exit(0); }); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(JSON.stringify({ event: 'broker_start_failed', message: error.message }));
  process.exit(1);
}
