import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { performance } from 'perf_hooks';
import {
  AcceptInviteDto,
  InviteUserDto,
  SignupInviteDto,
} from './dto/invite-user.dto';
import { LoginDto } from './dto/login.dto';
import { RecoverPasswordDto } from './dto/recover-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ResendInvitationDto } from './dto/resend-invitation.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AllowWithoutPassword } from './guards/password-set.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { elapsedMs, toServerTimingHeader } from './helpers/auth-helpers';
import { AuthService } from './services/auth.service';
import { SupabaseJwtPayload } from './types/jwt-payload.interface';
import { AuthenticatedUser } from './types/tenant-context.interface';

@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post('invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Invite a user by email and prepare tenant/role provisioning',
  })
  inviteUser(@Body() dto: InviteUserDto) {
    return this.authService.inviteUser(dto);
  }

  @Post('signup-invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Public signup from landing: create tenant/branch/OWNER and send invite',
  })
  signupInvite(@Body() dto: SignupInviteDto) {
    return this.authService.signupInvite(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @AllowWithoutPassword()
  @ApiOperation({
    summary: 'Current user profile + tenant + role + permissions + branches',
  })
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const totalStart = performance.now();
    const timings: Record<string, number> = {};
    const authUser = req.user as AuthenticatedUser;
    const profile = await this.authService.getCurrentProfile(authUser, timings);
    timings.total = elapsedMs(totalStart);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Server-Timing', toServerTimingHeader(timings));
    this.logger.log(
      `me userId=${authUser.id} total=${timings.total.toFixed(1)}ms`,
    );
    return profile;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign in with email and password. Returns session tokens + local profile.',
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const totalStart = performance.now();
    const timings: Record<string, number> = {};
    const response = await this.authService.login(dto, timings);
    timings.total = elapsedMs(totalStart);

    res.setHeader('Server-Timing', toServerTimingHeader(timings));
    return response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange a refresh_token for a new session. Same response shape as login.',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const totalStart = performance.now();
    const timings: Record<string, number> = {};
    const response = await this.authService.refresh(dto, timings);
    timings.total = elapsedMs(totalStart);

    res.setHeader('Server-Timing', toServerTimingHeader(timings));
    return response;
  }

  @Post('recover-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a password recovery email via Supabase.' })
  recoverPassword(@Body() dto: RecoverPasswordDto) {
    return this.authService.recoverPassword(dto);
  }

  @Post('resend-invitation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resend the access email to an invited user who has not activated yet.',
  })
  resendInvitation(@Body() dto: ResendInvitationDto) {
    return this.authService.resendInvitation(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowWithoutPassword()
  @ApiOperation({
    summary:
      'Reset password using the Supabase recovery access_token sent as Bearer.',
  })
  resetPassword(@Req() req: Request, @Body() dto: ResetPasswordDto) {
    const authUser = req.user as AuthenticatedUser | undefined;
    const authPayload = (req as Request & { authPayload?: SupabaseJwtPayload })
      .authPayload;
    return this.authService.resetPassword(authUser, authPayload, dto);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowWithoutPassword()
  @ApiOperation({
    summary:
      'Complete invitation: set password. Required before using the POS.',
  })
  acceptInvite(@Req() req: Request, @Body() dto: AcceptInviteDto) {
    const authUser = req.user as AuthenticatedUser | undefined;
    const authPayload = (req as Request & { authPayload?: SupabaseJwtPayload })
      .authPayload;
    return this.authService.acceptInvite(authUser, authPayload, dto);
  }
}
