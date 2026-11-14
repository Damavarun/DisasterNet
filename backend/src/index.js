import { readConfig } from './config.js';
import { createStore } from './store.js';
import { createApp } from './server.js';

let store;
let application;
try {
  const config = readConfig();
  store = await createStore(config);
  await store.migrate();
  application = await createApp(config, store);
  const address = await application.start();
  console.log(`DisasterNet ready at http://localhost:${address.port}`);
  console.log(`Node: ${config.NODE_NAME} | Network: ${config.NETWORK_NAME}`);
  console.log('Peer addresses:', application.service.network.addresses());
  console.log('Use the access PIN from backend/.env. A local network is required; internet is not.');
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await application.stop();
    await store.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
} catch (error) {
  console.error('DisasterNet could not start:', error.code ?? error.message);
  console.error('Check Node.js >=22.14, backend/.env, and your local MySQL database.');
  await application?.stop().catch(() => {});
  await store?.close();
  process.exitCode = 1;
}
