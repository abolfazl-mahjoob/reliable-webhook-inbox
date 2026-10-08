import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB, databaseProvider } from './database';
import { InboxService } from './inbox.service';
import { InboxWorker } from './worker';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [WebhookController],
  providers: [databaseProvider, InboxService, InboxWorker],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.end();
  }
}
