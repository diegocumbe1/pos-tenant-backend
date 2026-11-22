import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  PlayMundialAccess,
  PlayMundialLinkService,
} from './playmundial-link.service';
import { bearerOf } from './playmundial.helpers';

type WithAccess = Request & { playMundial?: PlayMundialAccess };

/**
 * Autentica a Play Mundial (máquina a máquina) con el token de la sede. No hay
 * usuario ni JWT: el token YA dice a qué negocio y sede puede mirar, y de ahí
 * no sale. El mensaje de error es el mismo para token ausente, mal formado,
 * desconocido o revocado: no se le dice a un curioso cuál de los cuatro fue.
 */
@Injectable()
export class PlayMundialTokenGuard implements CanActivate {
  constructor(private readonly links: PlayMundialLinkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WithAccess>();
    const token = bearerOf(req.headers.authorization);
    const access = token ? await this.links.authenticate(token) : null;
    if (!access) throw new UnauthorizedException('Token inválido');
    req.playMundial = access;
    return true;
  }
}

/** El negocio y la sede que resolvió `PlayMundialTokenGuard`. */
export const PlayMundialAccessParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlayMundialAccess => {
    const req = context.switchToHttp().getRequest<WithAccess>();
    if (!req.playMundial) {
      throw new InternalServerErrorException(
        'Acceso de Play Mundial ausente: falta PlayMundialTokenGuard',
      );
    }
    return req.playMundial;
  },
);
