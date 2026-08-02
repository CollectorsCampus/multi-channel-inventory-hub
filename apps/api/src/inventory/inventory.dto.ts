import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ALLOCATION_MODES, SKU_CONDITIONS, STOCK_MOVEMENT_REASONS } from '@hub/db';

/**
 * Quantities are `Int` everywhere and prices are integer cents — never floats.
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * any property without a decorator here is stripped and any unexpected one is
 * rejected outright.
 */

export const INVENTORY_SORT_FIELDS = ['name', 'quantityOnHand', 'updatedAt', 'condition'] as const;

export class ListInventoryQueryDto {
  @ApiPropertyOptional({ description: 'Free-text match against the catalog item name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({ enum: SKU_CONDITIONS })
  @IsOptional()
  @IsIn(SKU_CONDITIONS as unknown as string[])
  condition?: string;

  @ApiPropertyOptional({ description: 'Only items allocated to this channel.' })
  @IsOptional()
  @IsString()
  channelInstanceId?: string;

  @ApiPropertyOptional({
    description: 'Only items whose catalog item has no game — non-TCG goods and hand-entered rows.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  noGame?: boolean;

  @ApiPropertyOptional({
    description:
      'Only items on no channel at all — "what have I not listed yet". Ignored when ' +
      'channelInstanceId is also given, since the two ask opposite questions.',
  })
  @IsOptional()
  // `@Type(() => Boolean)` would be wrong here: every non-empty query string is
  // truthy, so `?unlisted=false` would filter. An explicit comparison is the
  // only thing that reads a query param as the boolean it looks like.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unlisted?: boolean;

  @ApiPropertyOptional({ description: 'Only items with stock in no fixed partition.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasUnallocated?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ enum: INVENTORY_SORT_FIELDS, default: 'name' })
  @IsOptional()
  @IsIn(INVENTORY_SORT_FIELDS as unknown as string[])
  sortBy?: (typeof INVENTORY_SORT_FIELDS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

export class CreateInventoryItemDto {
  @ApiProperty({ example: 'Charizard' })
  @IsString()
  @MaxLength(300)
  name!: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({ example: 'Base Set' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  setName?: string;

  @ApiProperty({ enum: SKU_CONDITIONS })
  @IsIn(SKU_CONDITIONS as unknown as string[])
  condition!: string;

  @ApiPropertyOptional({ default: 'NORMAL', description: 'Foil, 1st edition, ...' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  printing?: string;

  @ApiPropertyOptional({ default: 'EN' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantityOnHand?: number;

  @ApiPropertyOptional({ description: 'Cents.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  costBasis?: number;

  /**
   * An existing platform id for this product, so the catalog is keyed on
   * canonical external ids rather than one we invented (§4).
   */
  @ApiPropertyOptional({ example: 'tcgplayer' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  externalSource?: string;

  @ApiPropertyOptional({ example: '42366' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;
}

export class AdjustQuantityDto {
  @ApiProperty({ description: 'Signed. +5 for intake, -1 for shrinkage.' })
  @Type(() => Number)
  @IsInt()
  delta!: number;

  @ApiProperty({ enum: STOCK_MOVEMENT_REASONS })
  @IsIn(STOCK_MOVEMENT_REASONS as unknown as string[])
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SetReserveDto {
  @ApiProperty({ minimum: 0, description: 'Held back from every pooled listing.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reserveQuantity!: number;
}

export class AllocationWriteDto {
  @ApiProperty()
  @IsString()
  channelInstanceId!: string;

  @ApiProperty({ enum: ALLOCATION_MODES })
  @IsIn(ALLOCATION_MODES as unknown as string[])
  mode!: 'fixed' | 'pooled';

  @ApiPropertyOptional({ description: 'fixed mode only: the exclusive partition size.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantityAllocated?: number | null;

  @ApiPropertyOptional({ description: 'pooled mode only. Omit or null to mirror the whole pool.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxQuantity?: number | null;

  @ApiPropertyOptional({ description: 'Cents, channel-specific.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number | null;

  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({
    description:
      "The channel's own listing id — a Shopify ProductVariant GID, a TCGPlayer SKU id. " +
      'Omit to leave unchanged; send null to detach the link without deleting the allocation.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: AllocationWriteDto) => o.externalListingId !== null)
  @IsString()
  @MaxLength(200)
  externalListingId?: string | null;
}

/**
 * Intake references a catalog product by source and id only.
 *
 * Deliberately does not accept the product's name, image or external ids: the
 * server re-fetches those from the source. Trusting them would let a client
 * write arbitrary values into CatalogExternalRef, which is what every future
 * listing is keyed on.
 */
export class IntakeDto {
  @ApiProperty({ example: 'scryfall' })
  @IsString()
  @MaxLength(50)
  sourceKey!: string;

  @ApiProperty({ description: "The source's own product id." })
  @IsString()
  @MaxLength(200)
  sourceId!: string;

  @ApiProperty({ enum: SKU_CONDITIONS })
  @IsIn(SKU_CONDITIONS as unknown as string[])
  condition!: string;

  @ApiPropertyOptional({ default: 'NORMAL', example: 'FOIL' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  printing?: string;

  @ApiPropertyOptional({ default: 'EN' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Cents, per unit.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  costBasis?: number;
}

/** Body for the dry-run endpoint backing the allocation editor's live validation. */
export class PreviewLedgerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantityOnHand?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reserveQuantity?: number;

  @ApiPropertyOptional({ type: [AllocationWriteDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationWriteDto)
  allocations?: AllocationWriteDto[];
}
