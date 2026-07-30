import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { CatalogIngestService } from './catalog-ingest.service';

export class ListSetsQueryDto {
  @ApiProperty({ example: 'tcgcsv' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, { message: 'sourceKey must be lowercase alphanumeric.' })
  sourceKey!: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;
}

export class IngestDto {
  @ApiProperty({ example: 'tcgcsv' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, { message: 'sourceKey must be lowercase alphanumeric.' })
  sourceKey!: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({
    example: ['3:24448'],
    description: 'Set ids from /catalog/ingest/sets. Omitted means every set for the game.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  setIds?: string[];

  @ApiPropertyOptional({ default: 50, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxSets?: number;
}

/**
 * Filling the local catalog.
 *
 * **Admin only, and both routes are deliberately separate.** Listing sets is
 * cheap and read-only; ingesting is minutes of third-party requests and writes
 * thousands of rows. An operator should be able to see what a run would cover
 * before starting it, which is the same reason matching proposes before it
 * confirms.
 */
@ApiTags('catalog')
@Controller('catalog/ingest')
export class CatalogIngestController {
  constructor(private readonly ingest: CatalogIngestService) {}

  @Get('sets')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Sets a catalog source can be ingested from.' })
  sets(@Query() query: ListSetsQueryDto) {
    return this.ingest.listSets(query.sourceKey, query.game);
  }

  /**
   * Runs synchronously and returns the report.
   *
   * Synchronous because an operator who pressed this wants to know what it did,
   * the same reasoning `POST /channels/:id/reconcile` follows. It is bounded by
   * `maxSets`, and the service refuses rather than truncates when a request
   * would exceed it — a catalog that looks complete and is not would be worse
   * than an error.
   */
  @Post()
  @RequireRole('admin')
  @ApiOperation({ summary: 'Ingest sets from a catalog source into the local catalog.' })
  run(@Body() body: IngestDto) {
    return this.ingest.ingest({
      sourceKey: body.sourceKey,
      ...(body.game !== undefined ? { game: body.game } : {}),
      ...(body.setIds !== undefined ? { setIds: body.setIds } : {}),
      ...(body.maxSets !== undefined ? { maxSets: body.maxSets } : {}),
    });
  }
}
