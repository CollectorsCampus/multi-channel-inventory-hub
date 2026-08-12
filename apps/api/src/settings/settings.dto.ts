import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Every field optional, and absent means "leave alone".
 *
 * The same rule the rest of this API follows for partial writes, and it is what
 * lets the form send only what changed — which matters most for the client
 * secret, where blank has to mean "keep the one you have" rather than "clear
 * it". Clearing is an explicit empty string.
 */
export class UpdateOidcSettingsDto {
  @ApiPropertyOptional({ description: 'Offer SSO at all. Needs an issuer and client id first.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'https://login.microsoftonline.com/<tenant>/v2.0' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  issuer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientId?: string;

  @ApiPropertyOptional({
    description:
      'Stored encrypted and never read back. Omit to keep the current one; send "" to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  clientSecret?: string;

  @ApiPropertyOptional({ default: 'openid profile email' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  scopes?: string;

  @ApiPropertyOptional({
    description:
      'Claim carrying groups or roles. Set it and the provider becomes authoritative: the ' +
      'mapped role is reapplied on every login. Empty leaves roles managed here.',
    example: 'roles',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleClaim?: string;

  @ApiPropertyOptional({
    description: 'JSON object mapping claim values to roles. Matched exactly, including case.',
    example: '{"admin":"admin","viewer":"viewer"}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  roleMap?: string;

  @ApiPropertyOptional({ enum: ['viewer', 'editor', 'admin'] })
  @IsOptional()
  @IsIn(['viewer', 'editor', 'admin'])
  defaultRole?: 'viewer' | 'editor' | 'admin';

  @ApiPropertyOptional({
    description:
      'Keep password login working alongside SSO. Refused while no SSO user has ever signed ' +
      'in, because turning it off first locks everyone out of a flow nobody has proven.',
  })
  @IsOptional()
  @IsBoolean()
  allowLocalLogin?: boolean;

  @ApiPropertyOptional({
    description:
      'Comma-separated extra origins the issuer’s endpoints may live on. Google needs this; ' +
      'Entra, Auth0, Keycloak and Okta do not.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  allowedEndpointOrigins?: string;
}

/** Partial write for the remote-syslog form; absent means "leave alone". */
export class UpdateSyslogSettingsDto {
  @ApiPropertyOptional({ description: 'Ship alerts and sync activity to the collector below.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: '192.168.1.50', description: 'Collector hostname or address.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ default: 514 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ enum: ['udp', 'tcp'], default: 'udp' })
  @IsOptional()
  @IsIn(['udp', 'tcp'])
  protocol?: 'udp' | 'tcp';
}

/** Partial write for the email-alerting form; absent means "leave alone". */
export class UpdateEmailSettingsDto {
  @ApiPropertyOptional({ description: 'Email alerts at or above the threshold below.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'smtp.mx.cloudflare.net', description: 'SMTP server.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ default: 587 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ description: 'Implicit TLS (port 465). Off attempts STARTTLS.' })
  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @ApiPropertyOptional({ description: 'Blank sends without authentication.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @ApiPropertyOptional({
    description:
      'Stored encrypted and never read back. Omit to keep the current one; send "" to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  password?: string;

  @ApiPropertyOptional({ example: 'hub@example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  from?: string;

  @ApiPropertyOptional({ description: 'Comma-separated recipients.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  to?: string;

  @ApiPropertyOptional({ enum: ['critical', 'warning', 'info'], default: 'warning' })
  @IsOptional()
  @IsIn(['critical', 'warning', 'info'])
  threshold?: 'critical' | 'warning' | 'info';
}
