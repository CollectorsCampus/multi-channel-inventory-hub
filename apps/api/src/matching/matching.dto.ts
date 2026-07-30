import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SKU_CONDITIONS } from '@hub/db';

export class ProposeMatchesDto {
  @ApiProperty({ example: 'tcgcsv', description: 'Catalog source to draw candidates from.' })
  @IsString()
  @MaxLength(50)
  // Same shape `validateCatalogSource` enforces on a real source key. Constrained
  // here too because the value reaches an object key, and `__proto__` arriving
  // from a request body should be rejected at the edge rather than reasoned about
  // further in.
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'sourceKey must be lowercase alphanumeric with dashes.',
  })
  sourceKey!: string;

  @ApiProperty({
    example: 'Surging Sparks',
    description:
      'The set to scope this run to. Required — an unscoped run is both a catalogue walk and ' +
      'a review screen nobody reads.',
  })
  @IsString()
  @MaxLength(200)
  setName!: string;

  @ApiPropertyOptional({ example: 'Pokemon' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  game?: string;

  @ApiPropertyOptional({ description: "Opaque channel cursor from a previous page's response." })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;

  @ApiPropertyOptional({ description: 'Channel listings per page.', default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

/**
 * One confirmed link.
 *
 * Carries ids and SKU dimensions only. The product's name, image and external ids
 * are re-fetched from the source server-side, for the reason `IntakeDto` gives:
 * trusting them would let a client write arbitrary values into
 * `CatalogExternalRef`, which is what every future listing is keyed on.
 */
export class ConfirmLinkDto {
  @ApiProperty({ description: "The channel's own listing id, from a proposal." })
  @IsString()
  @MaxLength(200)
  externalListingId!: string;

  @ApiProperty({ example: 'tcgcsv' })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'sourceKey must be lowercase alphanumeric with dashes.',
  })
  sourceKey!: string;

  @ApiProperty({ description: "The source's own product id." })
  @IsString()
  @MaxLength(200)
  sourceId!: string;

  @ApiProperty({
    enum: SKU_CONDITIONS,
    description:
      'Required. The server will not infer a condition — it decides most of what a single is ' +
      'worth, and a wrong default is worse than a prompt.',
  })
  @IsIn(SKU_CONDITIONS as unknown as string[])
  condition!: string;

  @ApiPropertyOptional({ default: 'NORMAL' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  printing?: string;

  @ApiPropertyOptional({ default: 'EN' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ description: 'Cents. Omit to leave the allocation unpriced.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number;
}

export class ConfirmMatchesDto {
  @ApiProperty({ type: [ConfirmLinkDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmLinkDto)
  links!: ConfirmLinkDto[];

  @ApiPropertyOptional({
    default: false,
    description:
      "Also write the catalog id into the channel's seller-SKU field. **Overwrites whatever is " +
      'there**, which on a real storefront is usually a code the seller relies on. Off unless ' +
      'explicitly requested, and only ever applied to a listing whose link was just confirmed.',
  })
  @IsOptional()
  @IsBoolean()
  writeSkuToChannel?: boolean;
}
