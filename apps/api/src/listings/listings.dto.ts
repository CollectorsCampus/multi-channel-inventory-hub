import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_ITEMS } from './listing-creation.service';

/**
 * One custom field to set, as the channel described it.
 *
 * Deliberately not validated beyond shape and length. The core has no way to
 * know what a valid value looks like — on Shopify it is a metaobject id — and a
 * guess here would reject the correct answer.
 */
export class ListingMetafieldDto {
  @ApiProperty({ enum: ['product', 'variant'] })
  @IsIn(['product', 'variant'])
  owner!: 'product' | 'variant';

  @ApiProperty({ example: 'custom' })
  @IsString()
  @MaxLength(100)
  namespace!: string;

  @ApiProperty({ example: 'game' })
  @IsString()
  @MaxLength(100)
  key!: string;

  @ApiProperty({ example: 'metaobject_reference' })
  @IsString()
  @MaxLength(100)
  type!: string;

  @ApiProperty({ example: 'gid://shopify/Metaobject/141624803381' })
  @IsString()
  @MaxLength(2000)
  value!: string;
}

export class CreateListingsDto {
  @ApiProperty({
    type: [String],
    description:
      'Ledger items to list, chosen by the operator. Never a filter or a whole import — a ' +
      '1,333-row import must not become 1,333 storefront products.',
  })
  @IsArray()
  @ArrayNotEmpty()
  // The service refuses an oversized run too, and says so in the operator's
  // terms. This is here so the body is bounded before anything reads it.
  @ArrayMaxSize(MAX_ITEMS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  inventoryItemIds!: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      "Applied verbatim to products this run creates. **Never derived**: the store's " +
      'collections are keyed on exact tags, so a guessed tag produces a product that is ' +
      'visible in the admin and in no collection. Empty means no tags.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    type: [ListingMetafieldDto],
    description:
      'Custom fields to set on products this run creates, chosen from GET .../listings/metafields. ' +
      'Applied verbatim: the value is the channel’s own identifier and means nothing here.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => ListingMetafieldDto)
  metafields?: ListingMetafieldDto[];

  @ApiPropertyOptional({
    example: 'gid://shopify/TaxonomyCategory/ae-2-2-3-2',
    description:
      "The channel's own product classification, applied verbatim. Usually required by the " +
      'metafields: most definitions are conditional on a category, and a product without one ' +
      'has every metafield rejected. Take it from requiresCategory on the chosen fields.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;

  @ApiPropertyOptional({ description: 'Publisher or brand. Applied verbatim.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor?: string;

  @ApiPropertyOptional({
    default: 'Condition',
    description: 'What distinguishes variants of one card on this channel.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  optionName?: string;
}

export class ListTagsQueryDto {
  @ApiPropertyOptional({ description: 'Most tags to return.', default: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
