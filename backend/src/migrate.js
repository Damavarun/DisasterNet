import { readConfig } from './config.js';
import { createStore } from './store.js';

let store;
try {
  store = await createStore(readConfig());
  await store.migrate();
  console.log('MySQL schema is ready.');
} catch (error) {
  console.error('Migration failed:', error.code ?? error.message);
  process.exitCode = 1;
} finally { await store?.close(); }
