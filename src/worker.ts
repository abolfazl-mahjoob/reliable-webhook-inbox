import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InboxService } from './inbox.service';

@Injectable()
export class InboxWorker {
  private running = false;
  constructor(private readonly inbox: InboxService) {}

  @Interval(1000)
  async tick(): Promise<void> {
    if (process.env.DISABLE_SCHEDULED_WORKER === 'true' || this.running) return;
    this.running = true;
    try { await this.inbox.drain(20); }
    catch (error) {
      // Log error class only. Avoid raw body, headers, tokens and user data.
      console.error('inbox-drain-failed', error instanceof Error ? error.name : 'UnknownError');
    } finally {
      this.running = false;
    }
  }
}
