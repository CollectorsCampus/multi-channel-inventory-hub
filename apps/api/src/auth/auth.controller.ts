import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, Public } from './decorators';
import { AuthService } from './auth.service';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from './session.service';
import { AUTH_PROVIDER, type AuthProvider } from './auth-provider.interface';
import type { AuthenticatedPrincipal } from './auth-provider.interface';
// Value imports, not type-only: ValidationPipe reads these classes at runtime
// from `design:paramtypes` metadata to validate and transform request bodies.
import {
  AuthStatusDto,
  ChangePasswordDto,
  CurrentUserDto,
  FirstRunSetupDto,
  LoginDto,
} from './auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Whether setup is needed, and which auth provider is active.' })
  async status(): Promise<AuthStatusDto> {
    return {
      needsSetup: await this.auth.needsFirstRunSetup(),
      providerKey: this.provider.key,
      providerDisplayName: this.provider.displayName,
      supportsDirectLogin: this.provider.supportsDirectLogin,
      // Derived from the provider rather than from config, so the login page
      // cannot offer an SSO button on a deployment that has no SSO bound.
      ssoStartPath: this.provider.key === 'oidc' ? '/api/auth/oidc/start' : null,
    };
  }

  @Public()
  @Post('setup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create the initial admin. Only available before any user exists.' })
  async setup(@Body() body: FirstRunSetupDto): Promise<{ ok: true }> {
    await this.auth.createFirstAdmin(body.username, body.password);
    return { ok: true };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for a session cookie.' })
  async login(
    @Body() body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CurrentUserDto> {
    const session = await this.auth.login(body.username, body.password, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    // Deliberately identical for unknown user and wrong password.
    if (!session) throw new UnauthorizedException('Invalid username or password');

    const secure = this.config.get<string>('APP_URL', '').startsWith('https://');

    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      expires: session.expiresAt,
    });

    // Readable by the SPA on purpose: the double-submit pattern requires the
    // client to echo this value back in the X-CSRF-Token header.
    reply.setCookie(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure,
      path: '/',
      expires: session.expiresAt,
    });

    const resolved = await this.sessions.resolve(session.token);
    if (!resolved) throw new UnauthorizedException();

    return resolved.principal;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session and clear its cookies.' })
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.revoke(token);

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('me')
  @ApiOperation({ summary: 'The currently authenticated principal.' })
  me(@CurrentUser() user: AuthenticatedPrincipal): CurrentUserDto {
    return user;
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change own password. Revokes all other sessions.' })
  async changePassword(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }
}
