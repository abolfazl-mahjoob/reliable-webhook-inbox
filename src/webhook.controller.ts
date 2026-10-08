import { Controller, Get, HttpCode, Post, Param, Req, Inject } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { DB } from './database';
import { InboxService } from './inbox.service';

@Controller()
export class WebhookController {
  constructor(
    private readonly inbox: InboxService,
    @Inject(DB) private readonly db: Pool,
  ) {}

  @Get('health')
  async health(): Promise<{ ok: true }> {
    await this.db.query('SELECT 1');
    return { ok: true };
  }

  @Post('webhooks/:tenantId')
  @HttpCode(202)
  async accept(
    @Param('tenantId') tenantId: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    return this.inbox.receive(tenantId, request.headers, request.rawBody);
  }
}
