import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { USER_ROLES } from '@hub/db';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy';

/**
 * Length is bounded here and the *policy* is applied in the service, on
 * purpose: this stops an absurd body before anything reads it, while the rule
 * an operator is told about stays in one place for every path that sets a
 * password.
 */
export class CreateUserDto {
  @ApiProperty({ example: 'jsmith' })
  @IsString()
  @MaxLength(100)
  username!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ enum: USER_ROLES })
  @IsIn(USER_ROLES as unknown as string[])
  role!: (typeof USER_ROLES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: USER_ROLES })
  @IsOptional()
  @IsIn(USER_ROLES as unknown as string[])
  role?: (typeof USER_ROLES)[number];

  @ApiPropertyOptional({
    description:
      'Deactivating takes effect immediately — sessions and API keys both check it on every ' +
      'request. The last active admin cannot be deactivated.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string | null;
}

export class SetPasswordDto {
  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}
