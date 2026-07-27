import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  username!: string;

  @ApiProperty({ example: 'correct horse battery staple', format: 'password' })
  password!: string;
}

export class FirstRunSetupDto {
  @ApiProperty({ example: 'admin' })
  username!: string;

  @ApiProperty({ minLength: 12, format: 'password' })
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  currentPassword!: string;

  @ApiProperty({ minLength: 12, format: 'password' })
  newPassword!: string;
}

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
