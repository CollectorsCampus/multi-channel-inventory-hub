import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { CatalogService } from './catalog.service';
import { CatalogMergeService } from './catalog-merge.service';
import { CatalogDuplicatesService } from './catalog-duplicates.service';
import { CatalogClearService } from './catalog-clear.service';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { CatalogCredentialsService } from './catalog-credentials.service';

export class CatalogClearQueryDto {
  @ApiPropertyOptional({
    example: 'Pokemon',
    description: 'Restrict to one game, matched exactly. Omitted covers every game.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;
}

export class ClearCatalogDto extends CatalogClearQueryDto {}

export class MergeCatalogItemsDto {
  @ApiProperty({
    description: 'The item that survives. Its id keeps every SKU already built on it.',
  })
  @IsString()
  @MaxLength(64)
  winnerId!: string;

  @ApiProperty({ description: 'The duplicate, deleted once its SKUs and ids have moved across.' })
  @IsString()
  @MaxLength(64)
  loserId!: string;
}

export class CatalogSearchQueryDto {
  @ApiPropertyOptional({ example: 'lightning bolt' })
  @IsString()
  @MaxLength(200)
  text!: string;

  @ApiPropertyOptional({ example: 'Magic', description: 'Restrict to sources covering this game.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({ example: 'Masters 25' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  setName?: string;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class LocalSetsQueryDto {
  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;
}

export class SetCatalogCredentialsDto {
  @ApiProperty({
    description: "Secret values, keyed by the source's declared secretFields. Write-only.",
    type: Object,
  })
  @IsObject()
  secrets!: Record<string, string>;
}

export class LocalSearchQueryDto {
  @ApiPropertyOptional({
    example: 'pikachu',
    description: 'Omitted returns the set or game unfiltered, which is the browse case.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  text?: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({ example: 'ME02: Phantasmal Flames' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  setName?: string;

  @ApiPropertyOptional({ default: 50, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly merge: CatalogMergeService,
    private readonly duplicates: CatalogDuplicatesService,
    private readonly clear: CatalogClearService,
    private readonly registry: CatalogSourceRegistry,
    private readonly credentials: CatalogCredentialsService,
  ) {}

  /**
   * Which of a source's declared secret fields are set, never their values.
   *
   * Mirrors `ChannelsService.toSummary`'s trade for connector credentials — an
   * operator who has lost a token re-enters it rather than this endpoint ever
   * being able to leak it back out.
   */
  @Get('sources/:key/credentials')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Which credential fields a catalog source needs, and which are set.' })
  credentialStatus(@Param('key') key: string) {
    return this.credentials.status(this.registry.get(key));
  }

  /**
   * Store credentials for a catalog source — CardTrader's bearer token, today.
   *
   * Merged with whatever is already stored, so rotating one field does not
   * require re-entering the others. Refused for a source that declares no
   * `secretFields`: nothing here would ever be read.
   */
  @Put('sources/:key/credentials')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Store credentials for a catalog source.' })
  async setCredentials(@Param('key') key: string, @Body() body: SetCatalogCredentialsDto) {
    await this.credentials.setSecrets(this.registry.get(key), body.secrets);
    return this.credentials.status(this.registry.get(key));
  }

  /**
   * What clearing the local catalog would remove, without removing it.
   *
   * The same shape ingest already follows — list before you commit — because
   * this is the destructive counterpart and deserves the same caution.
   */
  @Get('local/clear-preview')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'What clearing the local catalog would remove, without removing anything.',
    description:
      'Counts only. An item with even one SKU is always kept, whatever its stock — this can ' +
      'never remove a card, set or box that has ever been added to the ledger.',
  })
  clearPreview(@Query() query: CatalogClearQueryDto) {
    return this.clear.preview({ ...(query.game !== undefined ? { game: query.game } : {}) });
  }

  /**
   * Delete catalog items that hold no SKU.
   *
   * Admin-only, and named "clear" rather than "delete" deliberately: what this
   * removes is identity data an ingest rebuilds, never a card or box an
   * operator holds. `CatalogClearService` is what actually enforces that; this
   * only shapes the request.
   */
  @Post('local/clear')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Clear catalog items ingest built that nothing has ever been added to the ledger for.',
    description:
      'Only items with zero SKUs are touched — an item with one, at any quantity, is always ' +
      'kept. Rebuilt by re-running an ingest. Scope to one game with `game`, or omit it to ' +
      'clear everything clearable.',
  })
  clearCatalog(@Body() body: ClearCatalogDto) {
    return this.clear.clear({ ...(body.game !== undefined ? { game: body.game } : {}) });
  }

  /**
   * Fold one catalog item into another.
   *
   * Admin-only, and destructive in a way nothing else here is: a catalog item
   * cascades to its SKUs, their inventory, and every stock movement and
   * allocation beneath. The service therefore validates completely before it
   * writes, and refuses rather than deciding anything about stock.
   */
  /**
   * Same-named items whose refs share no namespace — the signature of a
   * convergence failure, ranked by how sure the evidence is. Feeds the panel
   * that drives `local/merge`; nothing here writes anything.
   */
  @Get('local/duplicates')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Catalog items that look like one product, for the operator to merge or dismiss.',
    description:
      'Groups same-named items within a game whose external refs share no namespace — had ' +
      'they shared one, intake would have converged them. Same-named items with distinct ' +
      'collector numbers are excluded as reprints rather than offered: merging two real ' +
      'printings is the split this ledger exists to prevent, in the other direction.',
  })
  localDuplicates() {
    return this.duplicates.findDuplicates();
  }

  @Post('local/merge')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Merge a duplicate catalog item into another.',
    description:
      'For when two sources with no id in common created two items for one real product — ' +
      'the split each source inherits as its own SKUs and its own idea of the stock. The ' +
      'winner keeps its identity, because its id is what every SKU code already written to a ' +
      'storefront hangs off. Refused, with the rows named, if a duplicate SKU on the loser ' +
      'holds stock, allocations or history: merging cannot decide what happens to those.',
  })
  mergeItems(@Body() body: MergeCatalogItemsDto) {
    return this.merge.merge(body.winnerId, body.loserId);
  }

  @Get('sources')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Registered catalog sources and the games they cover.' })
  sources() {
    return this.catalog.listSources();
  }

  /**
   * Searches every source covering the requested game.
   *
   * Returns `failures` alongside `candidates`: catalog sources are third-party
   * services, and an operator mid-intake should see what did come back rather
   * than a blanket error.
   */
  @Get('search')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Search catalog sources for products.' })
  search(@Query() query: CatalogSearchQueryDto) {
    return this.catalog.search({
      text: query.text,
      game: query.game,
      setName: query.setName,
      limit: query.limit ?? 25,
    });
  }

  /**
   * The local catalog, which answers questions no source here will take.
   *
   * Separate from `/search` rather than a flag on it, because the two differ in
   * kind: `/search` fans out to third parties and reports per-source failures,
   * while this is one database query that either works or does not. Collapsing
   * them would mean a response shape that is half about network problems.
   */
  @Get('local/sets')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Sets held in the local catalog, with item counts.' })
  localSets(@Query() query: LocalSetsQueryDto) {
    return this.catalog.listLocalSets(query.game);
  }

  @Get('local/search')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Search the local catalog. Needs no network.' })
  async localSearch(@Query() query: LocalSearchQueryDto) {
    const candidates = await this.catalog.searchLocal({
      text: query.text ?? '',
      ...(query.game !== undefined ? { game: query.game } : {}),
      ...(query.setName !== undefined ? { setName: query.setName } : {}),
      limit: query.limit ?? 50,
    });

    // No `failures` key, deliberately: there is nothing here that can partially
    // fail, and echoing the remote search's shape would imply otherwise.
    return { candidates };
  }
}
