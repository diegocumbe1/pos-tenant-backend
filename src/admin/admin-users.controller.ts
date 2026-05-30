import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AdminService } from './admin.service';
import { ChangeUserEmailDto } from './dto/change-user-email.dto';

/**
 * Endpoints ROOT-only para gestión transversal de usuarios.
 * No requiere TenantGuard — ROOT opera por encima del scope.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PasswordSetGuard, PermissionsGuard)
@RequirePermissions('admin:tenants:manage')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly adminService: AdminService) {}

  @Patch('change-email')
  @ApiOperation({
    summary: 'Cambia el email de un usuario en Supabase Auth y en la DB local',
    description:
      'Actualiza primero Supabase, luego la fila local. Si la actualización local falla, intenta revertir Supabase. El usuario podrá hacer login con el nuevo email sin pasar por confirmación de correo.',
  })
  @ApiBody({ type: ChangeUserEmailDto })
  @ApiOkResponse({ description: 'Email actualizado correctamente.' })
  @ApiNotFoundResponse({ description: 'No existe un usuario con oldEmail.' })
  @ApiConflictResponse({
    description: 'newEmail ya está en uso local o en Supabase Auth.',
  })
  changeEmail(@Body() dto: ChangeUserEmailDto) {
    return this.adminService.changeUserEmail(dto);
  }
}
