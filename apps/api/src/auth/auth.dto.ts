import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request DTOs are validated by the global ValidationPipe, which is configured
 * with `whitelist` + `forbidNonWhitelisted` — any property without a decorator
 * here is stripped, and any unexpected property is rejected outright. A DTO
 * with no decorators therefore accepts nothing, so every field must declare
 * its constraints.
 */

const MIN_PASSWORD_LENGTH = 12;
// Bounded so a huge body cannot be turned into an argon2 denial-of-service.
const MAX_PASSWORD_LENGTH = 1024;

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username!: string;

  // Deliberately no MinLength: login must not disclose the password policy,
  // and an account created under an older policy must still be able to sign in.
  @ApiProperty({ example: 'correct horse battery staple', format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class FirstRunSetupDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, format: 'password' })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, format: 'password' })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

// Response shapes. Not validated — they exist to document the API surface.

export class CurrentUserDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ enum: ['viewer', 'editor', 'admin'] })
  role!: string;
}

export class AuthStatusDto {
  @ApiProperty({ description: 'True when no user exists yet and setup must run first.' })
  needsSetup!: boolean;

  @ApiProperty()
  providerKey!: string;

  @ApiProperty()
  providerDisplayName!: string;

  @ApiProperty({ description: 'False for redirect-based providers such as OIDC.' })
  supportsDirectLogin!: boolean;
}
