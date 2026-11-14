import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const backendDir = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: path.join(backendDir, '.env'), quiet: true });

export function readConfig(env = process.env) {
  const schema = z.object({
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3001),
    P2P_PORT: z.coerce.number().int().min(0).max(65535).default(9000),
    NODE_NAME: z.string().trim().min(1).max(60).default('Local node'),
    NETWORK_NAME: z.string().regex(/^[a-zA-Z0-9-]{1,48}$/).default('disasternet-local'),
    DATA_DIR: z.string().default('./data'),
    MYSQL_HOST: z.string().default('127.0.0.1'),
    MYSQL_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    MYSQL_USER: z.string().default('disasternet'),
    MYSQL_PASSWORD: z.string().default(''),
    MYSQL_DATABASE: z.string().regex(/^[a-zA-Z0-9_]+$/).default('disasternet'),
    BOOTSTRAP_PEERS: z.string().default(''),
    ACCESS_PIN: z.string().min(8, 'ACCESS_PIN must contain at least 8 characters'),
    ALLOWED_ORIGINS: z.string().default(''),
  });
  const config = schema.parse(env);
  return { ...config, DATA_DIR: path.resolve(backendDir, config.DATA_DIR) };
}
