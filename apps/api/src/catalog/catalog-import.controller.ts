import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { CatalogImportService } from './catalog-import.service';

export class CatalogImportItemDto {
  @ApiProperty({ example: 'GEN-1', description: 'Id unique within the namespace.' })
  @IsString()
  @MaxLength(100)
  id!: string;

  @ApiProperty({ example: 'Hex, Codemancer' })
  @IsString()
  @MaxLength(300)
  name!: string;

  @ApiPropertyOptional({ example: 'Genesis' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  setName?: string;

  @ApiPropertyOptional({ example: 'GEN-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  collectorNumber?: string;

  @ApiPropertyOptional({
    description: 'Publicly fetchable image URL. May expire; re-import refreshes it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^https?:\/\//, { message: 'imageUrl must be an http(s) URL.' })
  imageUrl?: string;
}

export class CatalogImportDto {
  @ApiProperty({ example: 'neuroscape', description: 'Keeps two imported games’ ids apart.' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'namespace must be lowercase alphanumeric with dashes.',
  })
  namespace!: string;

  @ApiProperty({ example: 'Neuroscape TCG' })
  @IsString()
  @MaxLength(100)
  game!: string;

  @ApiPropertyOptional({ example: 'Genesis', description: 'Default set for items without one.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  setName?: string;

  @ApiProperty({ type: [CatalogImportItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CatalogImportItemDto)
  items!: CatalogImportItemDto[];
}

/**
 * Loading hand-built card lists — the write half of the `imported` source.
 *
 * Admin only, synchronous, and it answers with the report, for the same
 * reason ingest does: an operator who pressed this wants to know what landed.
 */
@ApiTags('catalog')
@Controller('catalog/import')
export class CatalogImportController {
  constructor(private readonly importService: CatalogImportService) {}

  @Post()
  @RequireRole('admin')
  @ApiOperation({ summary: 'Import a card list into the local catalog under the imported source.' })
  run(@Body() body: CatalogImportDto) {
    return this.importService.import({
      namespace: body.namespace,
      game: body.game,
      ...(body.setName !== undefined ? { setName: body.setName } : {}),
      items: body.items.map((item) => ({
        id: item.id,
        name: item.name,
        ...(item.setName !== undefined ? { setName: item.setName } : {}),
        ...(item.collectorNumber !== undefined ? { collectorNumber: item.collectorNumber } : {}),
        ...(item.imageUrl !== undefined ? { imageUrl: item.imageUrl } : {}),
      })),
    });
  }
}
