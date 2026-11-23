import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { ApiPrincipal } from './api-keys.service.js';
import { ApiKeyGuard, Scope } from './api-key.guard.js';
import { IDEMPOTENCY_KEY_RE, listQuerySchema, meetingCreateSchema } from './ext-schemas.js';
import type { ExtMeetingsService } from './ext-meetings.service.js';
import { wrapExt } from './keys.controller.js';
import { EXT_MEETINGS } from './tokens.js';

type Req_ = { apiOrg: ApiPrincipal };

@Controller('v1/ext/meetings')
@UseGuards(ApiKeyGuard)
export class MeetingsExtController {
  constructor(@Inject(EXT_MEETINGS) private readonly meetings: ExtMeetingsService) {}

  @Get()
  @Scope('meetings:read')
  list(@Req() req: Req_, @Query() query: unknown) {
    const q = listQuerySchema.safeParse(query);
    if (!q.success) throw new HttpException('invalid query', 400);
    return wrapExt(this.meetings.list(req.apiOrg, q.data));
  }

  @Post()
  @Scope('meetings:write')
  async create(
    @Req() req: Req_,
    @Body() body: unknown,
    @Headers('idempotency-key') idem: string | undefined,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ) {
    const parsed = meetingCreateSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    if (idem !== undefined && !IDEMPOTENCY_KEY_RE.test(idem)) throw new HttpException('invalid Idempotency-Key', 400);
    const r = await wrapExt(this.meetings.create(req.apiOrg, parsed.data, idem));
    if (r.replay) res.setHeader('Idempotent-Replay', 'true');
    return r.body;
  }

  @Get(':id')
  @Scope('meetings:read')
  get(@Req() req: Req_, @Param('id') id: string) {
    return wrapExt(this.meetings.get(req.apiOrg, id));
  }

  @Delete(':id')
  @HttpCode(204)
  @Scope('meetings:write')
  async remove(@Req() req: Req_, @Param('id') id: string) {
    await wrapExt(this.meetings.remove(req.apiOrg, id));
  }
}
