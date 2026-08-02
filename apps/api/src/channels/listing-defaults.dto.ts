import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ListingMetafieldDto } from '../listings/listings.dto';

/**
 * What a channel should put on listings it creates.
 *
 * `ListingMetafieldDto` is imported rather than restated: it is the same field
 * on its way to the same connector, and a second copy would drift into
 * accepting something the creation path rejects.
 *
 * Every field is optional and every one is meaningful when present but empty —
 * `tags: []` is "no tags", not "unset". The service depends on that distinction
 * (see `applyListingDefaults`), so nothing here may coerce an empty array away.
 */
export class ChannelListingDefaultsDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Tags every product created here carries, applied verbatim. Pick them from ' +
      'GET /channels/:id/listings/tags — a tag the store does not already use usually means a ' +
      'product in no collection, which nothing reports. An empty array means no tags.',
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
      'Custom fields every product created here carries, from GET /channels/:id/listings/metafields.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => ListingMetafieldDto)
  metafields?: ListingMetafieldDto[];

  @ApiPropertyOptional({
    description:
      "The channel's own product classification. Usually required by the metafields above: most " +
      'definitions are conditional on a category, and a product without one has every metafield ' +
      'rejected with a message naming neither.',
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
}
