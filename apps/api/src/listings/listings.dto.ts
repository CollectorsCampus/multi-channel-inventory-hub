import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_ITEMS } from './listing-creation.service';

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
