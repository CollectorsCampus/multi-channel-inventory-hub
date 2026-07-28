import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { CatalogService } from './catalog.service';

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

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

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
}
