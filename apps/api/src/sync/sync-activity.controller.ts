import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ALERT_KINDS, ALERT_STATUSES, SYNC_DIRECTIONS, SYNC_OUTCOMES } from '@hub/db';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { SyncActivityService } from './sync-activity.service';

export class SyncEventQueryDto {
  @ApiPropertyOptional({ enum: SYNC_DIRECTIONS })
  @IsOptional()
  @IsIn(SYNC_DIRECTIONS as unknown as string[])
  direction?: string;

  @ApiPropertyOptional({ enum: SYNC_OUTCOMES })
  @IsOptional()
  @IsIn(SYNC_OUTCOMES as unknown as string[])
  outcome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  channelInstanceId?: string;

  @ApiPropertyOptional({
    description: "Comma-separated entity ids, for one item's own sync history.",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean).slice(0, 100) : undefined,
  )
  entityIds?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class AlertQueryDto {
  @ApiPropertyOptional({ enum: ALERT_STATUSES })
  @IsOptional()
  @IsIn(ALERT_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: ALERT_KINDS })
  @IsOptional()
  @IsIn(ALERT_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  channelInstanceId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

/**
 * Sync activity and the alert inbox (§7).
 *
 * Reading needs `viewer`; acting on an alert needs `editor`. Acknowledging is
 * an operational claim — "I am dealing with this" — so it records a name, and
 * a read-only user has no business making it.
 */
@ApiTags('sync')
@Controller('sync')
export class SyncActivityController {
  constructor(private readonly activity: SyncActivityService) {}

  @Get('events')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'The append-only sync log, newest first.' })
  events(@Query() query: SyncEventQueryDto) {
    return this.activity.listEvents(query);
  }

  @Get('alerts')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Alert inbox. Most severe first, then newest.' })
  alerts(@Query() query: AlertQueryDto) {
    return this.activity.listAlerts(query);
  }

  @Get('alerts/count')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'How many alerts are still open.' })
  async openCount(): Promise<{ open: number }> {
    return { open: await this.activity.openAlertCount() };
  }

  @Post('alerts/:id/acknowledge')
  @RequireRole('editor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim an alert without closing it.' })
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthenticatedPrincipal) {
    return this.activity.acknowledge(id, user.username);
  }

  @Post('alerts/:id/resolve')
  @RequireRole('editor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an alert.' })
  resolve(@Param('id') id: string, @CurrentUser() user: AuthenticatedPrincipal) {
    return this.activity.resolve(id, user.username);
  }

  @Post('alerts/:id/reopen')
  @RequireRole('editor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen an alert closed by mistake.' })
  reopen(@Param('id') id: string) {
    return this.activity.reopen(id);
  }
}
