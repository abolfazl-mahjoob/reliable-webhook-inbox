import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const DB = 'WEBHOOK_DB';

export const databaseProvider: Provider = {
  provide: DB,
  useFactory: () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  },
};
