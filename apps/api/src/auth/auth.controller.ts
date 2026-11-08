import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { CurrentUser, parse, Public, SessionUser } from '../common/http';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, signSession } from './session';

const zEmail = z.string().trim().toLowerCase().email('Email no válido');

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setSession(res: Response, user: SessionUser) {
    res.cookie(SESSION_COOKIE, signSession(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: config.sessionHours * 3600 * 1000,
      path: '/',
    });
  }

  @Public()
  @Get('setup/status')
  async setupStatus() {
    return { done: await this.auth.setupDone() };
  }

  @Public()
  @Post('setup')
  async setup(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    if (await this.auth.setupDone()) throw new ForbiddenException('La instalación ya está configurada');
    const input = parse(
      z.object({
        organizationName: z.string().trim().min(2),
        companyName: z.string().trim().min(2),
        companyTaxId: z.string().trim().min(8).max(12),
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        email: zEmail,
        password: z.string().min(10, 'Mínimo 10 caracteres'),
      }),
      body,
    );
    const user = await this.auth.setup(input);
    this.setSession(res, user);
    return { ok: true };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(z.object({ email: zEmail, password: z.string().min(1) }), body);
    const result = await this.auth.login(email, password, req.ip ?? '');
    if ('mfaRequired' in result) return result;
    this.setSession(res, result.user);
    return { ok: true };
  }

  @Public()
  @Post('auth/mfa')
  @HttpCode(200)
  async mfa(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { challenge, code } = parse(z.object({ challenge: z.string(), code: z.string() }), body);
    this.setSession(res, await this.auth.completeMfa(challenge, code));
    return { ok: true };
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Public()
  @Post('auth/forgot')
  @HttpCode(200)
  async forgot(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(z.object({ email: zEmail }), body);
    await this.auth.requestPasswordReset(email, req.ip ?? '');
    return { ok: true };
  }

  @Public()
  @Post('auth/set-password')
  @HttpCode(200)
  async setPassword(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { token, password } = parse(z.object({ token: z.string(), password: z.string() }), body);
    this.setSession(res, await this.auth.setPasswordWithToken(token, password));
    return { ok: true };
  }

  @Get('auth/me')
  me(@CurrentUser() user: SessionUser) {
    return this.auth.me(user);
  }

  @Post('auth/password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { current, next } = parse(z.object({ current: z.string(), next: z.string() }), body);
    await this.auth.changePassword(user, current, next);
    return { ok: true };
  }

  @Post('auth/mfa/setup')
  mfaSetup(@CurrentUser() user: SessionUser) {
    return this.auth.mfaSetup(user);
  }

  @Post('auth/mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { code } = parse(z.object({ code: z.string() }), body);
    await this.auth.mfaEnable(user, code);
    return { ok: true };
  }

  @Post('auth/mfa/disable')
  @HttpCode(200)
  async mfaDisable(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { password } = parse(z.object({ password: z.string() }), body);
    await this.auth.mfaDisable(user, password);
    return { ok: true };
  }
}
