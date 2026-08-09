import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ListingMetafieldDto } from '../listings/listings.dto';
import { TAG_RULE_MATCHES } from './listing-defaults';

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
/**
 * One "cards like this get this tag" rule.
 *
 * The tag is still the operator's, chosen from the store's own vocabulary. The
 * rule only says which cards it applies to, using facts the ledger holds.
 */
export class TagRuleDto {
  @ApiProperty({
    enum: TAG_RULE_MATCHES,
    description:
      "What to look at. `game` and `set` compare exactly against the catalogue's own values; " +
      '`name-contains` is for the one thing the hub does not model — what kind of product it ' +
      'is, which lives only inside the name ("Elite Trainer Box").',
  })
  @IsIn(TAG_RULE_MATCHES as unknown as string[])
  match!: (typeof TAG_RULE_MATCHES)[number];

  @ApiProperty({ example: 'Pokemon' })
  @IsString()
  @MaxLength(255)
  value!: string;

  @ApiProperty({ example: 'Pokémon', description: "The store's tag, applied verbatim." })
  @IsString()
  @MaxLength(255)
  tag!: string;
}

/**
 * One "cards like this get this vendor" rule.
 *
 * The vendor analogue of {@link TagRuleDto}, for a channel whose publishers vary
 * by game. The first matching rule wins.
 */
export class VendorRuleDto {
  @ApiProperty({ enum: TAG_RULE_MATCHES })
  @IsIn(TAG_RULE_MATCHES as unknown as string[])
  match!: (typeof TAG_RULE_MATCHES)[number];

  @ApiProperty({ example: 'Pokemon' })
  @IsString()
  @MaxLength(255)
  value!: string;

  @ApiProperty({ example: 'The Pokémon Company', description: 'Applied verbatim.' })
  @IsString()
  @MaxLength(255)
  vendor!: string;
}

/**
 * One "cards like this get this custom field" rule.
 *
 * The metafield analogue of {@link TagRuleDto}. `custom.game` varies by game and
 * `custom.set` by set, so — like tags — a fixed set per channel is only ever
 * right for a single-game, single-set batch.
 */
export class MetafieldRuleDto {
  @ApiProperty({ enum: TAG_RULE_MATCHES })
  @IsIn(TAG_RULE_MATCHES as unknown as string[])
  match!: (typeof TAG_RULE_MATCHES)[number];

  @ApiProperty({ example: 'Pokemon' })
  @IsString()
  @MaxLength(255)
  value!: string;

  @ApiProperty({ type: ListingMetafieldDto })
  @ValidateNested()
  @Type(() => ListingMetafieldDto)
  metafield!: ListingMetafieldDto;
}

export class ChannelListingDefaultsDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Tags every product created here carries **whatever it is**, applied verbatim. Usually ' +
      'empty: almost every tag a real store uses varies by game, set or kind of product, which ' +
      'is what tagRules is for. An empty array means none.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    type: [TagRuleDto],
    description:
      'Tags applied to a created product when they match it. This is how a mixed batch gets ' +
      'correct, different tags — a flat list per channel is only ever right for a ' +
      'single-game, single-set session.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TagRuleDto)
  tagRules?: TagRuleDto[];

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

  @ApiPropertyOptional({
    type: [MetafieldRuleDto],
    description:
      'Custom fields applied to a created product when a rule matches it — the metafield ' +
      'counterpart of tagRules, for fields that vary per card (custom.game by game, custom.set ' +
      'by set). Accumulated with the unconditional metafields above.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MetafieldRuleDto)
  metafieldRules?: MetafieldRuleDto[];

  @ApiPropertyOptional({ description: 'Publisher or brand. Applied verbatim.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor?: string;

  @ApiPropertyOptional({
    type: [VendorRuleDto],
    description:
      'Vendor applied to a created product when a rule matches it, falling back to the flat ' +
      'vendor above. First match wins, since a product has one vendor.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VendorRuleDto)
  vendorRules?: VendorRuleDto[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Sales channels (publication ids from GET /channels/:id/listings/publications) to publish ' +
      'every created product to. An empty array means none. Only acted on where the connector ' +
      'supports it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  publications?: string[];
}
