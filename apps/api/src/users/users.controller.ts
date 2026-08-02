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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { UsersService } from './users.service';
import { CreateUserDto, SetPasswordDto, UpdateUserDto } from './users.dto';

/**
 * User administration (§8). Admin-only throughout.
 *
 * The actor is taken from the session rather than the body on every mutating
 * route, because the "you cannot demote yourself" rules are only worth
 * anything if the caller cannot name someone else as the actor.
 */
@ApiTags('users')
@Controller('users')
@RequireRole('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Everyone with an account on this instance.' })
  list() {
    return this.users.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a local account.',
    description:
      'Always a local, password account — the kind someone signs into directly. Accounts from an ' +
      'identity provider are created by that provider on first login and cannot be made here.',
  })
  create(@Body() body: CreateUserDto) {
    return this.users.create(body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a role, or activate and deactivate.',
    description:
      'Refuses to leave the instance without an administrator: you cannot demote or deactivate ' +
      'yourself, and the last active admin cannot be demoted or deactivated by anyone.',
  })
  update(
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ) {
    return this.users.update(id, body, actor.userId);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Set a local account's password, for someone locked out.",
    description:
      'Distinct from changing your own, which requires the current password. Every existing ' +
      'session for that account is revoked, because a reset is usually a response to a ' +
      'compromise. Refused for accounts that sign in through an identity provider.',
  })
  async setPassword(@Param('id') id: string, @Body() body: SetPasswordDto): Promise<void> {
    await this.users.setPassword(id, body.password);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an account, with its sessions and API keys.',
    description: 'Same protections as deactivating. Deactivate instead to keep the audit trail.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<void> {
    await this.users.remove(id, actor.userId);
  }
}
