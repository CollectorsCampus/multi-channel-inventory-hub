import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators';
import { SettingsService } from './settings.service';
import { UpdateOidcSettingsDto } from './settings.dto';

/**
 * Instance settings an admin may change without a shell.
 *
 * Admin-only throughout, and that is the whole access story: these decide who
 * can sign in and with what role, so there is no read-only view for anyone
 * else. The deployment facts the settings screen already showed — the query
 * console, the channel count — stay where they are; this adds only the part
 * that was genuinely unreachable from a browser.
 */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('oidc')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Single sign-on configuration, and which fields the environment owns.',
    description:
      'Each field carries `managedByEnv`. Where that is true the environment declared it, the ' +
      'value cannot be changed here, and the form disables the input — so what is editable is ' +
      'exactly what this endpoint controls. The client secret is never returned; ' +
      '`clientSecretSet` says only whether one is stored.',
  })
  oidc() {
    return this.settings.view();
  }

  @Post('oidc/test')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Fetch the issuer’s discovery document, without saving anything.',
    description:
      'Proves the issuer resolves, that its endpoints satisfy the origin-pinning rule, and ' +
      'what they are. It does **not** prove the client secret: discovery is unauthenticated, ' +
      'and only a real code exchange exercises the secret.',
  })
  test(@Body() body: UpdateOidcSettingsDto) {
    return this.settings.test(body);
  }

  @Put('oidc')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Change single sign-on configuration.',
    description:
      'Applies immediately — no restart. Switching SSO **on** first fetches the discovery ' +
      'document and refuses if it cannot be reached, which is what replaces the boot-time ' +
      'check that environment-only configuration used to get. Turning password login off is ' +
      'refused until an SSO user has actually signed in.',
  })
  update(@Body() body: UpdateOidcSettingsDto) {
    return this.settings.update(body);
  }
}
