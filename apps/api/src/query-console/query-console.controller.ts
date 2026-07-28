import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { QueryConsoleService } from './query-console.service';

/**
 * The read-only SQL console (§7, §8: admin-only).
 *
 * Admin rather than editor for the same reason channels are: this reads every
 * table in the deployment, and that is a strictly larger power than editing the
 * ledger through validated endpoints.
 */

export class RunQueryDto {
  @ApiProperty({ example: 'SELECT count(*) FROM inventory_items' })
  @IsString()
  // Generous, because a real reporting query with several CTEs is long — but
  // bounded, because the body is logged and an unbounded string is a way to
  // fill a disk.
  @MaxLength(20_000)
  sql!: string;

  @ApiPropertyOptional({ description: 'Rows to return. Capped server-side.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRows?: number;
}

@ApiTags('query-console')
@Controller('query-console')
export class QueryConsoleController {
  constructor(private readonly console: QueryConsoleService) {}

  /**
   * Whether the console is usable here.
   *
   * Readable by any signed-in user, and deliberately says nothing but yes or no
   * — the UI needs it to decide whether to render a nav link, and a viewer
   * learning that the feature exists tells them nothing they could act on.
   */
  @Get('status')
  @ApiOperation({ summary: 'Whether the query console is enabled on this deployment.' })
  status() {
    return this.console.status();
  }

  @Post('query')
  @RequireRole('admin')
  // 200 rather than 201: this creates nothing. The console is a read.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run one read-only statement.' })
  run(@Body() body: RunQueryDto, @CurrentUser() user?: AuthenticatedPrincipal) {
    return this.console.run({ sql: body.sql, maxRows: body.maxRows }, user?.username ?? 'unknown');
  }
}
