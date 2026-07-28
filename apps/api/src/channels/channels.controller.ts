import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequireRole } from '../auth/decorators';
import { ChannelsService } from './channels.service';

/**
 * Channel configuration (§7).
 *
 * Admin-only throughout. §8 puts channels and credentials in the admin role
 * specifically: connecting a channel means storing a token that can change
 * prices and inventory on a live storefront, which is a strictly larger power
 * than editing the ledger.
 */

export class CreateChannelDto {
  @ApiProperty({ example: 'shopify', description: 'Which connector this channel uses.' })
  @IsString()
  @MaxLength(50)
  connectorKey!: string;

  @ApiProperty({ example: 'My Shopify Store' })
  @IsString()
  @MaxLength(200)
  displayName!: string;

  @ApiProperty({
    description: "Non-secret settings, shaped by the connector's configSchema.",
    type: Object,
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Secret values, keyed by the connector's declared secretFields. Write-only.",
    type: Object,
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;
}

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Only the secrets being changed. Write-only.', type: Object })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;
}

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  /**
   * Connectors available on this deployment, with the JSON Schema that drives
   * their settings form (§5). Listed before channels so the UI can offer a
   * picker even when nothing is configured yet.
   */
  @Get('connectors')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Available connectors and their configuration schemas.' })
  connectors() {
    return this.channels.listConnectors();
  }

  @Get()
  @RequireRole('admin')
  @ApiOperation({ summary: 'Configured channels. Secret values are never returned.' })
  list() {
    return this.channels.list();
  }

  @Get(':id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'One configured channel.' })
  get(@Param('id') id: string) {
    return this.channels.get(id);
  }

  @Post()
  @RequireRole('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Connect a channel.' })
  create(@Body() body: CreateChannelDto) {
    return this.channels.create(body);
  }

  @Patch(':id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Update settings, credentials, or enabled state.' })
  update(@Param('id') id: string, @Body() body: UpdateChannelDto) {
    return this.channels.update(id, body);
  }

  @Delete(':id')
  @RequireRole('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a channel. Refused while allocations reference it.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.channels.remove(id);
  }
}
