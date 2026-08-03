import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { CatalogService } from './catalog.service';
import { CatalogMergeService } from './catalog-merge.service';

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
  ) {}

  /**
   * Fold one catalog item into another.
   *
   * Admin-only, and destructive in a way nothing else here is: a catalog item
   * cascades to its SKUs, their inventory, and every stock movement and
   * allocation beneath. The service therefore validates completely before it
   * writes, and refuses rather than deciding anything about stock.
   */
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
