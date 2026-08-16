import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequireRole } from '../auth/decorators';
import { ChannelsService } from './channels.service';
import { ChannelListingDefaultsDto } from './listing-defaults.dto';
import { ChannelFilesService } from './channel-files.service';
import { ReconcileService } from '../sync/reconcile.service';
import { SelloutService } from '../sync/sellout.service';
import { IMPORT_KINDS, type ImportKind, type ImportSummary } from './file-transport';

/**
 * Channel configuration (§7).
 *
 * Admin-only throughout. §8 puts channels and credentials in the admin role
 * specifically: connecting a channel means storing a token that can change
 * prices and inventory on a live storefront, which is a strictly larger power
 * than editing the ledger.
 */

export class CreateChannelDto {
  @ApiProperty({ example: 'shopify', description: 'Which connector this channel uses.' })
  @IsString()
  @MaxLength(50)
  connectorKey!: string;

  @ApiProperty({ example: 'My Shopify Store' })
  @IsString()
  @MaxLength(200)
  displayName!: string;

  @ApiProperty({
    description: "Non-secret settings, shaped by the connector's configSchema.",
    type: Object,
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Secret values, keyed by the connector's declared secretFields. Write-only.",
    type: Object,
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;
}

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Only the secrets being changed. Write-only.', type: Object })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Re-push our quantity when reconciliation finds the channel showing something else. ' +
      'Acts in that direction only — the ledger is never rewritten from a channel.',
  })
  @IsOptional()
  @IsBoolean()
  reconcileAutoCorrect?: boolean;

  @ApiPropertyOptional({
    description:
      'Create a listing here for stock as it is taken in, instead of selecting it on /list. ' +
      'Refused unless listingDefaults says what a created product should carry — the hub ' +
      'applies tags and custom fields verbatim and will not guess one.',
  })
  @IsOptional()
  @IsBoolean()
  autoListNewStock?: boolean;

  @ApiPropertyOptional({
    description:
      'Draft a single’s product on the channel when its pushed quantity reaches zero — only if ' +
      'the platform itself shows the whole product out of stock, so a sibling variant with ' +
      'copies keeps it live. One direction: restocking never re-activates automatically.',
  })
  @IsOptional()
  @IsBoolean()
  draftAtSellout?: boolean;

  @ApiPropertyOptional({
    type: Object,
    description:
      'How this channel turns market prices into asking prices: enabled, conditionPercents ' +
      '(percent of market per condition — nothing is repriced for an undeclared condition), ' +
      'rounding ("none" | "99"), floorCents, autoApplyMaxPct (bigger moves queue for review; ' +
      'absent means everything reviews), minDeltaCents. Replaced wholesale. Malformed parts ' +
      'are dropped on read, so what round-trips is what applies.',
  })
  @IsOptional()
  @IsObject()
  repricingPolicy?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: ChannelListingDefaultsDto,
    description:
      'Replaced wholesale rather than merged, unlike config: this is one form section answering ' +
      'one question, and merging would make removing the last tag impossible.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelListingDefaultsDto)
  listingDefaults?: ChannelListingDefaultsDto;
}

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly files: ChannelFilesService,
    private readonly reconciler: ReconcileService,
    private readonly selloutService: SelloutService,
  ) {}

  /**
   * Connectors available on this deployment, with the JSON Schema that drives
   * their settings form (§5). Listed before channels so the UI can offer a
   * picker even when nothing is configured yet.
   */
  @Get('connectors')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Available connectors and their configuration schemas.' })
  connectors() {
    return this.channels.listConnectors();
  }

  @Get()
  @RequireRole('admin')
  @ApiOperation({ summary: 'Configured channels. Secret values are never returned.' })
  list() {
    return this.channels.list();
  }

  @Get(':id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'One configured channel.' })
  get(@Param('id') id: string) {
    return this.channels.get(id);
  }

  @Post()
  @RequireRole('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Connect a channel.' })
  create(@Body() body: CreateChannelDto) {
    return this.channels.create(body);
  }

  @Patch(':id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Update settings, credentials, or enabled state.' })
  update(@Param('id') id: string, @Body() body: UpdateChannelDto) {
    return this.channels.update(id, body);
  }

  @Delete(':id')
  @RequireRole('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a channel. Refused while allocations reference it.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.channels.remove(id);
  }

  /**
   * Reconcile this channel now (§6).
   *
   * Runs synchronously and returns the report, rather than queueing and handing
   * back a job id. An operator pressing this wants to know whether their
   * listings match, and a sweep of a few hundred listings at the connector's
   * declared rate is a wait they can sit through. The unattended nightly run is
   * the queued path.
   */
  @Post(':id/reconcile')
  @RequireRole('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare this channel against the ledger and report differences.' })
  reconcile(@Param('id') id: string, @Query('comparePrices') comparePrices?: string) {
    return this.reconciler.reconcileChannel(id, { comparePrices: comparePrices === 'true' });
  }

  /**
   * Draft every sold-out single on this channel now.
   *
   * The catch-up for the event path, which only fires where a push happened:
   * it reaches nothing that sold out before the channel opted in, and nothing
   * whose stock reached zero by a route that queued no push. Synchronous and
   * returning the report, for the same reason reconciliation is.
   *
   * Refused when the channel has the policy switched off — "off" and "nothing
   * sold out" are different facts, and only one of them is a setting.
   */
  @Post(':id/sellout')
  @RequireRole('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Draft this channel’s sold-out singles.',
    description:
      'Every linked single the ledger has at zero, subject to the same gates as the automatic ' +
      'path — including the platform’s own stock check, so a product with an in-stock sibling ' +
      'variant is left alone. One direction only: nothing is ever re-published.',
  })
  sellout(@Param('id') id: string) {
    return this.selloutService.sweepChannel(id);
  }

  // ---------------------------------------------------------------------------
  // File transport (ADR 0002)
  // ---------------------------------------------------------------------------

  /**
   * Download this channel's listings as a file to upload to the platform.
   *
   * The counts ride back in headers rather than in the body, because the body
   * is the file. `X-Listing-Count` and `X-Unmapped-Count` let the UI say "412
   * listings, 6 of them not covered" without a second round trip — and an
   * operator saving the file straight to disk loses nothing they needed.
   */
  @Get(':id/export')
  @RequireRole('admin')
  @ApiOperation({ summary: "Download this channel's listings as a platform-shaped file." })
  async exportFile(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const { file, total, unmapped } = await this.files.exportListings(id);

    await reply
      .header('Content-Type', file.contentType)
      // `attachment` and an explicit filename: without it the browser renders
      // the CSV as text and the operator has nothing to upload.
      .header('Content-Disposition', `attachment; filename="${sanitizeFilename(file.filename)}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Listing-Count', String(total))
      .header('X-Unmapped-Count', String(unmapped))
      // Both are non-standard, so a cross-origin caller cannot read them unless
      // they are named here. Same-origin is unaffected; this is for anyone
      // scripting against the API.
      .header('Access-Control-Expose-Headers', 'X-Listing-Count, X-Unmapped-Count')
      .send(file.content);
  }

  /**
   * Upload a file exported from the platform.
   *
   * `kind` is explicit rather than sniffed from the contents. The two imports
   * have very different consequences — one records sales and moves stock, the
   * other only reports — and having the operator say which they mean lets the
   * connector *verify* the file matches, rather than guess. Upload a pull sheet
   * as inventory and it is rejected by name.
   *
   * The body is the raw file, sent as `text/csv`. There is no multipart parser
   * in this application and adding one to carry a single field would be a
   * dependency to keep alive for no gain.
   */
  @Post(':id/import')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Upload a sales or inventory export from the platform.' })
  @ApiBody({ description: 'The raw file, as text/csv.', schema: { type: 'string' } })
  async importFile(
    @Param('id') id: string,
    @Query('kind') kind: string,
    @Query('filename') filename: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<ImportSummary> {
    if (!isImportKind(kind)) {
      throw new BadRequestException(
        `"kind" must be one of: ${IMPORT_KINDS.join(', ')}. It says which file this is, so ` +
          `the connector can check that it really is that file.`,
      );
    }

    const content = request.body;
    if (!Buffer.isBuffer(content)) {
      throw new BadRequestException(
        'Send the file as the request body with Content-Type: text/csv.',
      );
    }

    return this.files.importFile(id, kind, {
      filename: sanitizeFilename(filename ?? 'upload.csv'),
      content,
    });
  }
}

function isImportKind(value: string): value is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Strip anything that could escape a filename.
 *
 * On the way out it stops a quote or newline breaking the Content-Disposition
 * header; on the way in it stops a path separator reaching a log or a future
 * writer. The value is decorative either way, so being aggressive costs
 * nothing.
 */
function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[^\w.\- ]+/g, '').trim();
  return cleaned === '' ? 'upload.csv' : cleaned.slice(0, 120);
}
